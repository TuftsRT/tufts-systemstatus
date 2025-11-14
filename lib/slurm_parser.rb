require 'open3'
require 'json'

module SlurmParser
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
    output = run_command('sinfo -o "%P %a %l %D %t"')
    partitions = []
    
    output.each_line.drop(1).each do |line| # Skip header
      parts = line.strip.split(/\s+/)
      next if parts.length < 5
      
      partition = {
        name: parts[0].gsub('*', ''), # Remove default marker
        is_default: parts[0].include?('*'),
        available: parts[1] == 'up',
        time_limit: parts[2],
        nodes_count: parts[3].to_i,
        state: parts[4]
      }
      
      partitions << partition
    end
    
    partitions
  end

  # Parse squeue output for job information
  # Shows all jobs (running and pending) for the current user.
  # The UI has filters to show only running or pending jobs.
  def self.parse_queue
    output = run_command('squeue --me -o "%i %j %u %t %M %D %C %b %P %N"')
    jobs = []
    
    output.each_line.drop(1).each do |line| # Skip header
      parts = line.strip.split(/\s+/, 10)
      next if parts.length < 9
      
      # Parse GPU allocation from TRES format (e.g., "gres/gpu:a100:1" or "gres/gpu:2" or "N/A")
      gpu_tres = parts[7] || ''
      gpus = 0
      if gpu_tres =~ /gpu:(\w+):(\d+)/
        # Format: gres/gpu:TYPE:COUNT (e.g., gres/gpu:a100:1)
        gpus = $2.to_i
      elsif gpu_tres =~ /gpu:(\d+)/
        # Format: gres/gpu:COUNT (e.g., gres/gpu:2)
        gpus = $1.to_i
      end
      
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
        # For mixed/allocated, estimate based on CPU usage
        usage_ratio = node[:cpus_alloc].to_f / node[:cpus_total]
        in_use = (count * usage_ratio).round
        by_type[type][:in_use] += in_use
        by_type[type][:available] += (count - in_use)
      when 'down'
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
      
      summary[partition[:name]] = {
        total_nodes: partition_nodes.count,
        idle_nodes: partition_nodes.count { |n| n[:status] == 'idle' },
        mixed_nodes: partition_nodes.count { |n| n[:status] == 'mixed' },
        allocated_nodes: partition_nodes.count { |n| n[:status] == 'allocated' },
        down_nodes: partition_nodes.count { |n| n[:status] == 'down' },
        total_cpus: partition_nodes.sum { |n| n[:cpus_total] },
        available_cpus: partition_nodes.sum { |n| n[:cpus_free] },
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

  # Get complete dashboard data
  def self.get_dashboard_data
    nodes = parse_nodes
    partitions = parse_partitions
    jobs = parse_queue
    
    {
      timestamp: Time.now.to_i,
      nodes: nodes,
      partitions: partition_summary(partitions, nodes),
      gpu_summary: gpu_summary(nodes),
      jobs: jobs,
      stats: {
        total_nodes: nodes.count,
        total_cpus: nodes.sum { |n| n[:cpus_total] },
        available_cpus: nodes.sum { |n| n[:cpus_free] },
        total_memory_mb: nodes.sum { |n| n[:memory_total] },
        available_memory_mb: nodes.sum { |n| n[:memory_free] },
        total_jobs: jobs.count,
        running_jobs: jobs.count { |j| j[:state] == 'R' },
        pending_jobs: jobs.count { |j| j[:state] == 'PD' }
      }
    }
  end
end

