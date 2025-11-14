require 'sinatra'
require 'json'
require_relative 'lib/slurm_parser'

# Configure Sinatra
set :bind, '0.0.0.0'
set :public_folder, File.expand_path('public', __dir__)
set :views, File.expand_path('views', __dir__)
set :static, true
enable :static

# Main dashboard page
get '/' do
  erb :index
end

# API endpoint for dashboard data
get '/api/data' do
  content_type :json
  
  begin
    data = SlurmParser.get_dashboard_data
    { success: true, data: data }.to_json
  rescue => e
    status 500
    { success: false, error: e.message }.to_json
  end
end

# API endpoint for nodes only
get '/api/nodes' do
  content_type :json
  
  begin
    nodes = SlurmParser.parse_nodes
    { success: true, data: nodes }.to_json
  rescue => e
    status 500
    { success: false, error: e.message }.to_json
  end
end

# API endpoint for GPU summary
get '/api/gpu' do
  content_type :json
  
  begin
    nodes = SlurmParser.parse_nodes
    gpu_summary = SlurmParser.gpu_summary(nodes)
    { success: true, data: gpu_summary }.to_json
  rescue => e
    status 500
    { success: false, error: e.message }.to_json
  end
end

# API endpoint for partition info
get '/api/partitions' do
  content_type :json
  
  begin
    nodes = SlurmParser.parse_nodes
    partitions = SlurmParser.parse_partitions
    summary = SlurmParser.partition_summary(partitions, nodes)
    { success: true, data: summary }.to_json
  rescue => e
    status 500
    { success: false, error: e.message }.to_json
  end
end

# API endpoint for job queue
get '/api/queue' do
  content_type :json
  
  begin
    jobs = SlurmParser.parse_queue
    { success: true, data: jobs }.to_json
  rescue => e
    status 500
    { success: false, error: e.message }.to_json
  end
end

# Health check endpoint
get '/health' do
  content_type :json
  { status: 'ok', timestamp: Time.now.to_i }.to_json
end

