require 'open3'
require 'json'

module SlurmParser
  # Known CPU microarchitecture tags commonly added to Slurm node features.
  # Used to recognize the CPU type without hardcoding per-node mappings.
  CPU_MICROARCH_FEATURES = %w[
    nehalem westmere sandybridge ivybridge haswell broadwell
    skylake cascadelake cooperlake icelake
    sapphirerapids emeraldrapids graniterapids
    sierraforest clearwaterforest
    bulldozer piledriver steamroller excavator
    zen zen2 zen3 zen4 zen5
    naples rome milan genoa bergamo turin
    neoverse graviton ampere
  ].freeze

  def self.schedulable_node?(node)
    %w[idle mixed allocated].include?(node[:status])
  end

  # Detect a node's CPU type. Prefers a feature token that matches a known CPU
  # microarchitecture (e.g. "icelake", "zen3"); falls back to the Arch value
  # (e.g. "x86_64") so something useful is always returned.
  def self.detect_cpu_type(features, arch)
    if features && !features.empty?
      match = features.find { |f| CPU_MICROARCH_FEATURES.include?(f.to_s.downcase) }
      return match if match
    end
    arch
  end

  # Refine a base GPU type (from Gres, e.g. "a100") into a more specific variant
  # by inspecting AvailableFeatures (e.g. "a100-80G"). Slurm sites typically tag
  # memory size or other distinguishing attributes as a feature shaped like
  # "<base>-<suffix>" or "<base>_<suffix>". We pick the most informative match:
  # one whose suffix contains a memory size (e.g. 80G, 40GB) wins over a plain
  # variant tag. If nothing matches, the base type is returned unchanged.
  def self.refine_gpu_type(base_type, features)
    return base_type if base_type.nil? || features.nil? || features.empty?

    base = base_type.to_s.downcase
    variant_re = /\A#{Regexp.escape(base)}[-_]\S+\z/i

    variants = features.select do |feature|
      f = feature.to_s
      f.downcase != base && f =~ variant_re
    end

    return base_type if variants.empty?

    with_memory = variants.find { |v| v =~ /\d+\s*gb?\z/i }
    with_memory || variants.first
  end

  # Extract the gpu entry from a GRES-style field such as Gres= or GresUsed=.
  # Handles every spelling Slurm emits:
  #   gpu:4                  -> [nil, 4]       (no model configured)
  #   gpu:a100:4             -> ["a100", 4]
  #   gpu:a100:4(IDX:0-3)    -> ["a100", 4]
  #   gpu:2080ti:4           -> ["2080ti", 4]  (model starting with a digit)
  #   shard:8,gpu:a100:2     -> ["a100", 2]
  # Splitting on ':' rather than pattern-matching avoids mistaking a numeric
  # model name for the count (a regex like /gpu:(\d+)/ reads "gpu:2080ti:4" as
  # 2080 GPUs).
  # Returns nil when the field holds no gpu entry.
  def self.parse_gres_gpu(value)
    text = value.to_s
    return nil if text.empty? || text == '(null)'

    text.split(',').each do |token|
      entry = token.strip
      next unless entry.start_with?('gpu:')

      # Drop any trailing "(IDX:0-3)" / "(S:0-1)" detail.
      entry = entry.sub(/\(.*\z/, '')
      parts = entry.split(':')

      return [parts[1], parts[2].to_i] if parts.length >= 3
      return [nil, parts[1].to_i] if parts.length == 2
    end

    nil
  end

  def self.parse_job_gpu_count(gpu_field)
    value = gpu_field.to_s.strip
    return 0 if value.empty? || value == 'N/A' || value == '(null)'

    value.split(',').sum do |entry|
      token = entry.strip
      next 0 unless token.include?('gpu')

      if token =~ /gpu:\w+:(\d+)/
        $1.to_i
      elsif token =~ /gpu:(\d+)/
        $1.to_i
      elsif token =~ /gpu$/
        1
      else
        0
      end
    end
  end

  # Parse sinfo node-oriented output to determine which nodes should be visible
  # in the dashboard. We use sinfo as the source of truth for node visibility,
  # then enrich those nodes with scontrol hardware details.
  def self.parse_visible_nodes
    output = run_command('sinfo -N -h -o "%N|%P|%T"')
    visible_nodes = {}

    output.each_line do |line|
      parts = line.strip.split('|', 3)
      next if parts.length < 3

      node_names = expand_node_list(parts[0])
      partitions = parts[1].to_s.split(',').map { |partition| partition.delete('*') }.reject(&:empty?)
      state = parts[2].to_s.strip

      node_names.each do |node_name|
        visible_nodes[node_name] ||= { partitions: [], states: [] }
        visible_nodes[node_name][:partitions] |= partitions
        visible_nodes[node_name][:states] << state unless state.empty?
      end
    end

    visible_nodes
  end

  # Execute a command and return stdout
  def self.run_command(cmd)
    stdout, stderr, status = Open3.capture3(cmd)
    return stdout if status.success?

    # Log to STDERR so failures surface in the server logs. We still return the
    # (possibly empty) stdout instead of raising so one failing command does not
    # blank out the entire dashboard.
    STDERR.puts "[SlurmParser] Command failed (exit #{status.exitstatus}): #{cmd}"
    STDERR.puts "[SlurmParser] STDERR: #{stderr}" unless stderr.to_s.empty?
    stdout
  rescue => e
    STDERR.puts "[SlurmParser] Exception executing command: #{cmd.inspect} — #{e.message}"
    ""
  end

  # Execute a command given as separate argv elements (no shell involved), so a
  # value like a username can never be interpreted as shell syntax. Use this
  # instead of run_command whenever a command embeds external input.
  def self.run_command_argv(*args)
    stdout, stderr, status = Open3.capture3(*args)
    return stdout if status.success?

    STDERR.puts "[SlurmParser] Command failed (exit #{status.exitstatus}): #{args.join(' ')}"
    STDERR.puts "[SlurmParser] STDERR: #{stderr}" unless stderr.to_s.empty?
    stdout
  rescue => e
    STDERR.puts "[SlurmParser] Exception executing command: #{args.inspect} — #{e.message}"
    ""
  end

  # Parse scontrol show node --oneliner output
  def self.parse_nodes
    visible_nodes = parse_visible_nodes
    output = run_command('scontrol show node --oneliner')
    nodes = []
    
    output.each_line do |line|
      node = {}
      
      # Extract key fields using regex
      node[:name] = line[/NodeName=(\S+)/, 1]
      next unless visible_nodes.key?(node[:name])

      node[:state] = line[/State=(\S+)/, 1]
      node[:cpus_total] = line[/CPUTot=(\d+)/, 1].to_i
      node[:cpus_alloc] = line[/CPUAlloc=(\d+)/, 1].to_i
      node[:memory_total] = line[/RealMemory=(\d+)/, 1].to_i
      node[:memory_alloc] = line[/AllocMem=(\d+)/, 1].to_i
      node[:partitions] = visible_nodes[node[:name]][:partitions]
      
      # Extract GPU information from the Gres field.
      # Always initialise the GPU fields: a Gres value that is present but has no
      # recognisable gpu entry (e.g. "shard:8") must still leave has_gpu == false
      # rather than nil, or the frontend cannot tell GPU nodes from CPU nodes.
      node[:has_gpu] = false
      node[:gpu_type] = nil
      node[:gpu_base_type] = nil
      node[:gpu_count] = 0

      gpu_spec = parse_gres_gpu(line[/Gres=(\S+)/, 1])
      if gpu_spec && gpu_spec[1] > 0
        # Keep the raw Gres name around: it is what users must pass to
        # --gres=gpu:<name>:N. The display type may later be refined into a
        # feature-based variant (e.g. "a100-80G") which is NOT a valid Gres name.
        # Sites that configure GPUs without a model name use "gpu" itself.
        node[:gpu_base_type] = gpu_spec[0] || 'gpu'
        node[:gpu_type] = node[:gpu_base_type]
        node[:gpu_count] = gpu_spec[1]
        node[:has_gpu] = true
      end

      # Determine how many GPUs are in use.
      #
      # GresUsed is the authoritative per-node GRES usage field and is present in
      # `scontrol show node` output, so it is consulted first. AllocTRES only
      # carries gres/* entries on some Slurm versions and configurations; when it
      # does not, relying on it leaves gpu_alloc at 0, which makes every GPU node
      # look completely free and inflates every "available" figure on the
      # dashboard. AllocTRES remains a fallback in both its plain (gres/gpu=4)
      # and typed (gres/gpu:a100=4) spellings.
      node[:gpu_alloc] = 0
      if node[:has_gpu]
        used_spec = parse_gres_gpu(line[/GresUsed=(\S+)/, 1])
        alloc_tres = line[/AllocTRES=(\S+)/, 1]

        node[:gpu_alloc] =
          if used_spec
            used_spec[1]
          elsif alloc_tres =~ /gres\/gpu=(\d+)/
            $1.to_i
          elsif alloc_tres =~ /gres\/gpu:[^=,]+=(\d+)/
            $1.to_i
          else
            0
          end

        # Never report more in use than exist, so gpu_free cannot go negative.
        node[:gpu_alloc] = node[:gpu_count] if node[:gpu_alloc] > node[:gpu_count]
      end
      # Extract features
      features = line[/AvailableFeatures=(\S+)/, 1]
      node[:features] = features ? features.split(',') : []

      # Refine GPU type using features: e.g. base "a100" + feature "a100-80G" → "a100-80G".
      # This automatically splits same-model GPUs that differ by memory size (or any
      # other variant tag) into distinct types without hardcoding a list.
      if node[:has_gpu]
        node[:gpu_type] = refine_gpu_type(node[:gpu_type], node[:features])
      end

      # Detect CPU microarchitecture from features (e.g. "icelake"), falling
      # back to Arch (e.g. "x86_64") when no microarch tag is present.
      node[:cpu_type] = detect_cpu_type(node[:features], line[/Arch=(\S+)/, 1])

      # Simplified state
      node[:status] = case node[:state]
      when /DOWN/, /NOT_RESPONDING/, /FAIL/ then 'down'
      when /DRAIN/, /DRAINING/ then 'draining'
      when /IDLE/ then 'idle'
      when /MIXED/ then 'mixed'
      when /ALLOCATED/, /ALLOC/ then 'allocated'
      else 'unknown'
      end

      # Only schedulable nodes should contribute free capacity.
      node[:cpus_free] = schedulable_node?(node) ? (node[:cpus_total] - node[:cpus_alloc]) : 0
      node[:memory_free] = schedulable_node?(node) ? (node[:memory_total] - node[:memory_alloc]) : 0
      node[:gpu_free] = schedulable_node?(node) ? [node[:gpu_count] - node[:gpu_alloc], 0].max : 0
      
      nodes << node
    end
    
    nodes
  end

  # Determine which partitions are limited to a group or account.
  #
  # Contributed ("lab") partitions are created with AllowGroups=<unix group> or
  # AllowAccounts=<slurm account>, while open partitions leave both at ALL.
  # Asking Slurm is authoritative — much better than guessing from partition
  # names, which vary by site and silently break when a lab is renamed.
  #
  # owner_only describes the *partition*, never the nodes behind it: a contributed
  # node is normally also in a cluster-wide preemptible partition, so anyone can
  # still run on it that way.
  #
  # Note that PreemptMode is deliberately NOT read here. `scontrol show partition`
  # reports the cluster-wide default for any partition that does not override it,
  # so it marks unrelated partitions as preemptible. Which partitions are
  # preemptible is site policy, held in PREEMPTIBLE_PARTITIONS in public/script.js.
  #
  # If the command is unavailable the hash is empty and no claims are made.
  def self.parse_partition_access
    output = run_command('scontrol show partition --oneliner')
    access = {}

    output.each_line do |line|
      name = line[/PartitionName=(\S+)/, 1]
      next unless name

      groups = line[/AllowGroups=(\S+)/, 1]
      accounts = line[/AllowAccounts=(\S+)/, 1]

      open_to_all_groups = groups.nil? || groups.casecmp('all').zero?
      open_to_all_accounts = accounts.nil? || accounts.casecmp('all').zero?

      # The QOS a job in this partition uses by default when it does not
      # request one explicitly with --qos. (Which QOS a partition *accepts* is
      # site policy enforced outside of Slurm's AllowQos/DenyQos ACL here, so
      # it isn't derived from this output — see QOS_PARTITIONS in script.js.)
      default_qos = line[/\bQoS=(\S+)/, 1]

      access[name] = {
        allow_groups: open_to_all_groups ? nil : groups,
        allow_accounts: open_to_all_accounts ? nil : accounts,
        owner_only: !(open_to_all_groups && open_to_all_accounts),
        default_qos: (default_qos == '(null)' ? nil : default_qos)
      }
    end

    access
  end

  # Parse sinfo output for partition information
  def self.parse_partitions
    output = run_command('sinfo -h -o "%P|%a|%l|%D|%t"')
    partitions = {}

    output.each_line.each do |line|
      parts = line.strip.split('|', 5)
      next if parts.length < 5

      name = parts[0].gsub('*', '')
      partitions[name] ||= {
        name: name,
        is_default: parts[0].include?('*'),
        available: parts[1] == 'up',
        time_limit: parts[2],
        nodes_count: 0,
        states: []
      }

      partition = partitions[name]
      partition[:is_default] ||= parts[0].include?('*')
      partition[:available] &&= (parts[1] == 'up')
      partition[:time_limit] = parts[2] if partition[:time_limit].to_s.empty?
      partition[:nodes_count] += parts[3].to_i
      partition[:states] << parts[4] unless parts[4].to_s.empty?
    end

    partitions.values.map do |partition|
      states = partition.delete(:states).uniq
      partition[:state] = states.length == 1 ? states.first : 'mixed'
      partition
    end
  end

  # Parse squeue output for ALL jobs (all users)
  # Used for overall cluster statistics
  def self.parse_all_jobs
    # Use '|' as the field delimiter and -h to drop the header. Whitespace
    # splitting breaks on job names (%j) that contain spaces, shifting every
    # subsequent column; a pipe delimiter keeps the fixed columns aligned.
    output = run_command('squeue -h -o "%i|%j|%u|%t|%M|%D|%C|%b|%P|%N"')
    jobs = []

    output.each_line do |line|
      # Job names (%j) may themselves contain '|', so keep the fixed columns
      # from the right and rebuild the name from whatever is left in the middle.
      raw = line.chomp.split('|', -1)
      next if raw.length < 10

      trailing = raw.last(8) # user, state, time, nodes, cpus, gres, partition, nodelist
      parts = [raw[0], raw[1...(raw.length - 8)].join('|'), *trailing]

      gpu_tres = parts[7] || ''
      gpus = parse_job_gpu_count(gpu_tres)

      job = {
        job_id: parts[0],
        name: parts[1],
        user: parts[2],
        state: parts[3],
        time: parts[4],
        nodes: parts[5].to_i,
        cpus: parts[6].to_i,
        gpus: gpus,
        partition: parts[8],
        node_list: parts[9] || ''
      }

      jobs << job
    end
    
    jobs
  end

  # Get GPU summary statistics
  def self.gpu_summary(nodes)
    gpu_nodes = nodes.select { |n| n[:has_gpu] }
    
    by_type = Hash.new { |h, k| h[k] = { total: 0, available: 0, in_use: 0, down: 0 } }
    
    gpu_nodes.each do |node|
      type = node[:gpu_type]
      count = node[:gpu_count]
      
      by_type[type][:total] += count
      
      case node[:status]
      when 'idle'
        by_type[type][:available] += count
      when 'mixed', 'allocated'
        in_use =  node[:gpu_alloc]
        by_type[type][:in_use] += in_use
        by_type[type][:available] += (count - in_use)
      when 'down', 'draining'
        by_type[type][:down] += count
      end
    end
    
    by_type
  end

  # Get partition summary
  def self.partition_summary(partitions, nodes)
    summary = {}
    access = parse_partition_access

    partitions.each do |partition|
      partition_nodes = nodes.select { |n| n[:partitions].include?(partition[:name]) }
      schedulable_nodes = partition_nodes.select { |n| schedulable_node?(n) }
      partition_access = access[partition[:name]] || {}

      summary[partition[:name]] = {
        total_nodes: partition_nodes.count,
        idle_nodes: partition_nodes.count { |n| n[:status] == 'idle' },
        mixed_nodes: partition_nodes.count { |n| n[:status] == 'mixed' },
        allocated_nodes: partition_nodes.count { |n| n[:status] == 'allocated' },
        down_nodes: partition_nodes.count { |n| n[:status] == 'down' },
        total_cpus: partition_nodes.sum { |n| n[:cpus_total] },
        available_cpus: schedulable_nodes.sum { |n| n[:cpus_free] },
        has_gpu: partition_nodes.any? { |n| n[:has_gpu] },
        time_limit: partition[:time_limit],
        is_default: partition[:is_default],
        # owner_only means the partition is limited to a lab/group — not that its
        # nodes are unreachable, since contributed nodes are usually also in a
        # preemptible cluster-wide partition.
        owner_only: partition_access[:owner_only] || false,
        allow_groups: partition_access[:allow_groups],
        allow_accounts: partition_access[:allow_accounts],
        default_qos: partition_access[:default_qos]
      }
    end
    
    # Sort partitions: public partitions first in specific order, then lab partitions alphabetically
    sort_partitions(summary)
  end

  # Sort partitions with public partitions first, then lab partitions
  def self.sort_partitions(summary)
    # Define the order for public partitions
    public_order = ['batch', 'gpu', 'mpi', 'interactive', 'largemem', 'preempt']
    
    # Separate public and lab partitions
    public_partitions = []
    lab_partitions = []
    
    summary.each do |name, data|
      if public_order.include?(name)
        public_partitions << [name, data]
      else
        lab_partitions << [name, data]
      end
    end
    
    # Sort public partitions by the defined order
    public_partitions.sort_by! { |name, _| public_order.index(name) || 999 }
    
    # Sort lab partitions alphabetically
    lab_partitions.sort_by! { |name, _| name }
    
    # Combine and return as a hash
    (public_partitions + lab_partitions).to_h
  end

  # Split a Slurm TRES string (e.g. "cpu=250,gres/gpu=12,mem=5000G") into a
  # hash keyed by TRES name. Returns {} for blank/unset values.
  def self.parse_tres_string(value)
    return {} if value.nil? || value.to_s.empty?

    value.split(',').each_with_object({}) do |pair, acc|
      key, val = pair.split('=', 2)
      acc[key] = val unless key.nil? || key.empty?
    end
  end

  # Find which QOS names a user can use, grouped by the account (lab) that
  # grants them, plus that user's default QOS per association.
  #
  # username is passed as its own argv element (run_command_argv does not use a
  # shell), so it cannot be interpreted as command syntax.
  def self.parse_user_qos(username)
    output = run_command_argv('sacctmgr', '-n', '-P', 'show', 'assoc',
                               "user=#{username}", 'format=Account,QOS,DefaultQOS')

    qos_accounts = Hash.new { |h, k| h[k] = [] }
    default_qos = nil

    output.each_line do |line|
      parts = line.strip.split('|', -1)
      next if parts.length < 2

      account = parts[0]
      qos_list = parts[1].to_s.split(',').map(&:strip).reject(&:empty?)
      default_qos ||= parts[2].to_s.strip unless parts[2].to_s.strip.empty?

      qos_list.each do |qos|
        qos_accounts[qos] << account unless qos_accounts[qos].include?(account)
      end
    end

    { qos_accounts: qos_accounts, default_qos: default_qos }
  end

  # Look up MaxTRESPU/MaxJobsPU/MaxWall for the given QOS names only.
  def self.parse_qos_limits(qos_names)
    return {} if qos_names.empty?

    output = run_command_argv('sacctmgr', '-n', '-P', 'show', 'qos', 'format=Name,MaxTRESPU,MaxJobsPU,MaxWall')
    limits = {}

    output.each_line do |line|
      parts = line.strip.split('|', -1)
      name = parts[0]
      next unless name && qos_names.include?(name)

      max_wall = parts[3].to_s.strip
      limits[name] = {
        max_tres_pu: parse_tres_string(parts[1]),
        max_jobs_pu: parts[2].to_s.strip.empty? ? nil : parts[2].to_i,
        max_wall: max_wall.empty? ? nil : max_wall
      }
    end

    limits
  end

  # Get the QOS available to a user, with resource-per-user limits, for display
  # on the dashboard. Each QOS appears once even if granted by multiple accounts.
  def self.user_qos_summary(username)
    return [] if username.to_s.empty?

    assoc = parse_user_qos(username)
    limits = parse_qos_limits(assoc[:qos_accounts].keys)

    assoc[:qos_accounts].keys.sort.map do |name|
      qos_limits = limits[name] || {}
      {
        name: name,
        is_default: name == assoc[:default_qos],
        # Slurm accounts this QOS is granted through. Not shown directly, but
        # needed to scope which lab partitions a user can reach with
        # normal-contrib — lab partitions are named after their account.
        accounts: assoc[:qos_accounts][name].sort,
        max_tres_pu: qos_limits[:max_tres_pu] || {},
        max_jobs_pu: qos_limits[:max_jobs_pu],
        max_wall: qos_limits[:max_wall]
      }
    end
  end

  # Parse scontrol show reservations output
  # Returns a hash mapping node names to their reservation info
  def self.parse_reservations
    output = run_command('scontrol show reservations')
    node_reservations = {}

    current_reservation = nil

    output.each_line do |line|
      # New reservation starts with ReservationName=
      if line =~ /ReservationName=(\S+)/
        current_reservation = {
          name: $1,
          start_time: line[/StartTime=(\S+)/, 1],
          end_time: line[/EndTime=(\S+)/, 1],
          state: nil,
          nodes: []
        }
      end

      # Extract nodes (can be in format: pax046 or pax[025-026])
      if line =~ /Nodes=(\S+)/ && current_reservation
        nodes_str = $1
        current_reservation[:nodes] = expand_node_list(nodes_str)
      end

      # Extract state
      if line =~ /State=(\S+)/ && current_reservation
        current_reservation[:state] = $1

        # Now that we have all info, map nodes to this reservation
        current_reservation[:nodes].each do |node_name|
          node_reservations[node_name] ||= []
          node_reservations[node_name] << {
            name: current_reservation[:name],
            start_time: current_reservation[:start_time],
            end_time: current_reservation[:end_time],
            state: current_reservation[:state]
          }
        end
      end
    end

    node_reservations
  end

  # Expand SLURM node list notation (e.g., "pax[025-026]" -> ["pax025", "pax026"])
  def self.expand_node_list(nodes_str)
    nodes = []

    # Handle comma-separated node specs
    nodes_str.split(',').each do |spec|
      if spec =~ /^([a-zA-Z]+)\[([^\]]+)\]$/
        # Format: prefix[range] e.g., pax[025-026]
        prefix = $1
        ranges = $2

        ranges.split(',').each do |range|
          if range.include?('-')
            start_num, end_num = range.split('-')
            width = start_num.length
            (start_num.to_i..end_num.to_i).each do |num|
              nodes << "#{prefix}#{num.to_s.rjust(width, '0')}"
            end
          else
            nodes << "#{prefix}#{range}"
          end
        end
      else
        # Simple node name
        nodes << spec
      end
    end

    nodes
  end

  # Get complete dashboard data
  def self.get_dashboard_data
    nodes = parse_nodes
    partitions = parse_partitions
    all_jobs = parse_all_jobs  # Get all jobs for stats (all users)
    reservations = parse_reservations  # Get reservation info
    schedulable_nodes = nodes.select { |node| schedulable_node?(node) }

    # Add reservation info to each node
    nodes.each do |node|
      node[:reservations] = reservations[node[:name]] || []
    end
    
    {
      timestamp: Time.now.to_i,
      nodes: nodes,
      jobs_raw: all_jobs,
      partitions: partition_summary(partitions, nodes),
      gpu_summary: gpu_summary(nodes),
      stats: {
        total_nodes: nodes.count,
        total_cpus: nodes.sum { |n| n[:cpus_total] },
        available_cpus: schedulable_nodes.sum { |n| n[:cpus_free] },
        total_memory_mb: nodes.sum { |n| n[:memory_total] },
        available_memory_mb: schedulable_nodes.sum { |n| n[:memory_free] },
        total_gpus: nodes.sum { |n| n[:gpu_count] || 0 },
        available_gpus: schedulable_nodes.sum { |n| n[:gpu_free] || 0 },
        total_jobs: all_jobs.count,            # Count all jobs across all users
        running_jobs: all_jobs.count { |j| j[:state] == 'R' },  # Count running jobs from all users
        pending_jobs: all_jobs.count { |j| j[:state] == 'PD' }  # Count pending jobs from all users
      }
    }
  end
end
