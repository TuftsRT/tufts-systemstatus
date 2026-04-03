require 'open3'
require 'json'

module SlurmParser
  def self.schedulable_node?(node)
    %w[idle mixed allocated].include?(node[:status])
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

  # Execute a command and return stdout
  def self.run_command(cmd)
    stdout, stderr, status = Open3.capture3(cmd)
    return stdout if status.success?
    raise "Command failed: #{cmd}\n#{stderr}"
  rescue => e
    puts "Error executing command: #{e.message}"
    ""
  end

  # Parse scontrol show node --oneliner output
  def self.parse_nodes
    output = run_command('scontrol show node --oneliner')
    nodes = []
    
    output.each_line do |line|
      node = {}
      
      # Extract key fields using regex
      node[:name] = line[/NodeName=(\S+)/, 1]
      node[:state] = line[/State=(\S+)/, 1]
      node[:cpus_total] = line[/CPUTot=(\d+)/, 1].to_i
      node[:cpus_alloc] = line[/CPUAlloc=(\d+)/, 1].to_i
      node[:memory_total] = line[/RealMemory=(\d+)/, 1].to_i
      node[:memory_alloc] = line[/AllocMem=(\d+)/, 1].to_i
      node[:partitions] = line[/Partitions=(\S+)/, 1]&.split(',') || []
      
      # Extract GPU information from Gres field
      gres = line[/Gres=(\S+)/, 1]
      if gres && gres != "(null)"
        # Format: gpu:type:count or gpu:type:count(S:socket)
        if gres =~ /gpu:(\w+):(\d+)/
          node[:gpu_type] = $1
          node[:gpu_count] = $2.to_i
          node[:has_gpu] = true
        end
      else
        node[:has_gpu] = false
        node[:gpu_type] = nil
        node[:gpu_count] = 0
      end

      # Extract GPU allocation from AllocTRES field
      # Format: AllocTRES=cpu=8,mem=277G,gres/gpu=4
      alloc_tres = line[/AllocTRES=(\S+)/, 1]
      node[:gpu_alloc] = 0
      if alloc_tres && node[:has_gpu]
        # Look for gres/gpu=N in the AllocTRES string
        if alloc_tres =~ /gres\/gpu=(\d+)/
          node[:gpu_alloc] = $1.to_i
        end
      end
      node[:gpu_free] = node[:gpu_count] - node[:gpu_alloc]
      
      # Extract features
      features = line[/AvailableFeatures=(\S+)/, 1]
      node[:features] = features ? features.split(',') : []
      
      # Calculate availability
      node[:cpus_free] = node[:cpus_total] - node[:cpus_alloc]
      node[:memory_free] = node[:memory_total] - node[:memory_alloc]
      
      # Simplified state
      node[:status] = case node[:state]
      when /IDLE/ then 'idle'
      when /MIXED/ then 'mixed'
      when /ALLOCATED/, /ALLOC/ then 'allocated'
      when /DOWN/ then 'down'
      when /DRAIN/ then 'draining'
      else 'unknown'
      end
      
      nodes << node
    end
    
    nodes
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
    output = run_command('squeue -o "%i %j %u %t %M %D %C %b %P %N"')
    jobs = []
    
    output.each_line.drop(1).each do |line| # Skip header
      parts = line.strip.split(/\s+/, 10)
      next if parts.length < 9
      
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
    
    partitions.each do |partition|
      partition_nodes = nodes.select { |n| n[:partitions].include?(partition[:name]) }
      schedulable_nodes = partition_nodes.select { |n| schedulable_node?(n) }
      
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
        is_default: partition[:is_default]
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
        total_jobs: all_jobs.count,            # Count all jobs across all users
        running_jobs: all_jobs.count { |j| j[:state] == 'R' },  # Count running jobs from all users
        pending_jobs: all_jobs.count { |j| j[:state] == 'PD' }  # Count pending jobs from all users
      }
    }
  end
end
