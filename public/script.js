// Cluster Monitor Dashboard - Main JavaScript

class ClusterDashboard {
    constructor() {
        this.autoRefreshInterval = null;
        this.refreshIntervalMs = 30000; // 30 seconds
        this.currentSort = { field: null, ascending: true };
        this.currentJobSort = { field: null, ascending: true };
        this.currentFilter = 'all';
        this.currentSearch = '';
        this.allNodes = [];
        this.allJobs = [];
        this.currentJobFilter = 'all';
        this.currentJobSearch = '';
        // Debug mode: enable by visiting the page with ?debug=1
        const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
        this.debugEnabled = (params && params.get('debug') === '1') || (typeof window !== 'undefined' && window.DASHBOARD_DEBUG === true);
        
        this.init();
    }

    debug(...args) {
        if (this.debugEnabled && typeof console !== 'undefined') {
            console.log('[ClusterDashboard]', ...args);
        }
    }

    init() {
        // Set up event listeners
        document.getElementById('refresh-btn').addEventListener('click', () => this.loadData());
        document.getElementById('auto-refresh-toggle').addEventListener('change', (e) => this.toggleAutoRefresh(e.target.checked));
        document.getElementById('node-search').addEventListener('input', (e) => this.handleSearch(e.target.value));
        document.getElementById('node-filter').addEventListener('change', (e) => this.handleFilter(e.target.value));
        document.getElementById('job-search').addEventListener('input', (e) => this.handleJobSearch(e.target.value));
        document.getElementById('job-filter').addEventListener('change', (e) => this.handleJobFilter(e.target.value));
        
        // Set up table sorting for nodes
        document.querySelectorAll('thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => this.handleSort(th.dataset.sort));
        });

        // Set up table sorting for jobs
        document.querySelectorAll('thead th[data-sort-job]').forEach(th => {
            th.addEventListener('click', () => this.handleJobSort(th.dataset.sortJob));
        });

        // Initial data load
        this.loadData();
        
        // Start auto-refresh
        this.toggleAutoRefresh(true);
    }

    toggleAutoRefresh(enabled) {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }

        if (enabled) {
            this.autoRefreshInterval = setInterval(() => this.loadData(), this.refreshIntervalMs);
        }
    }

    async loadData() {
        this.showLoading(true);
        this.hideError();

        try {
            const base = (typeof window !== 'undefined' && window.APP_BASE_PATH) ? window.APP_BASE_PATH : '';
            const response = await fetch(`${base}/api/data`);
            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Failed to load data');
            }
            this.debug('testing testing 123');

            this.debug('Fetched dashboard data at', new Date().toISOString(), {
                stats: result.data?.stats,
                gpuTypes: Object.keys(result.data?.gpu_summary || {}),
                partitions: Object.keys(result.data?.partitions || {}),
                nodes: (result.data?.nodes || []).length,
                jobs: (result.data?.jobs || []).length
            });

            this.renderDashboard(result.data);
            this.updateLastUpdateTime();
        } catch (error) {
            console.error('Error loading dashboard data:', error);
            this.showError(error.message);
        } finally {
            this.showLoading(false);
        }
    }

    renderDashboard(data) {
        this.allNodes = data.nodes;
        
        this.debug('Rendering dashboard...', {
            totalNodes: this.allNodes.length,
            gpuSummary: data.gpu_summary,
            partitionsKeys: Object.keys(data.partitions || {}),
            jobsCount: (data.jobs || []).length
        });

        // Update stats
        this.updateStats(data.stats);
        
        // Update GPU overview
        this.updateGPUCards(data.gpu_summary);
        
        // Update partitions
        this.updatePartitions(data.partitions);
        
        // Update nodes table
        this.updateNodesTable(this.allNodes);
        
        // Update job queue
        this.updateJobQueue(data.jobs);
    }

    updateStats(stats) {
        this.debug('Stats update', stats);
        document.getElementById('stat-total-nodes').textContent = stats.total_nodes;
        document.getElementById('stat-available-cpus').textContent = stats.available_cpus;
        document.getElementById('stat-total-cpus').textContent = `of ${stats.total_cpus} total`;
        
        const availMemGB = Math.round(stats.available_memory_mb / 1024);
        const totalMemGB = Math.round(stats.total_memory_mb / 1024);
        document.getElementById('stat-available-memory').textContent = `${availMemGB} GB`;
        document.getElementById('stat-total-memory').textContent = `of ${totalMemGB} GB total`;
        
        document.getElementById('stat-running-jobs').textContent = stats.running_jobs;
        document.getElementById('stat-total-jobs').textContent = `${stats.total_jobs} total jobs`;
    }

    updateGPUCards(gpuSummary) {
        this.debug('GPU summary', gpuSummary);
        const container = document.getElementById('gpu-cards');
        
        if (Object.keys(gpuSummary).length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-microchip"></i><p>No GPU nodes found</p></div>';
            return;
        }

        const colors = ['#667eea', '#f093fb', '#4facfe', '#43e97b', '#fa709a'];
        let colorIndex = 0;

        container.innerHTML = Object.entries(gpuSummary).map(([type, stats]) => {
            const total = stats.total;
            const available = stats.available;
            const inUse = stats.in_use;
            const down = stats.down;
            const usagePercent = total > 0 ? Math.round((inUse / total) * 100) : 0;
            
            const color1 = colors[colorIndex % colors.length];
            const color2 = colors[(colorIndex + 1) % colors.length];
            colorIndex++;

            return `
                <div class="gpu-card" style="background: linear-gradient(135deg, ${color1} 0%, ${color2} 100%);">
                    <div class="gpu-card-header">
                        <div class="gpu-type">${type.toUpperCase()}</div>
                        <div class="gpu-icon"><i class="fas fa-microchip"></i></div>
                    </div>
                    <div class="gpu-stats">
                        <div class="gpu-stat">
                            <span class="gpu-stat-label">Total GPUs</span>
                            <span class="gpu-stat-value">${total}</span>
                        </div>
                        <div class="gpu-stat">
                            <span class="gpu-stat-label">Available</span>
                            <span class="gpu-stat-value">${available}</span>
                        </div>
                        <div class="gpu-stat">
                            <span class="gpu-stat-label">In Use</span>
                            <span class="gpu-stat-value">${inUse}</span>
                        </div>
                        ${down > 0 ? `
                        <div class="gpu-stat">
                            <span class="gpu-stat-label">Down</span>
                            <span class="gpu-stat-value">${down}</span>
                        </div>
                        ` : ''}
                    </div>
                    <div class="gpu-progress">
                        <div class="gpu-progress-bar" style="width: ${usagePercent}%"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    updatePartitions(partitions) {
        this.debug('Partitions summary', partitions);
        const container = document.getElementById('partition-cards');
        
        if (Object.keys(partitions).length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-layer-group"></i><p>No partitions found</p></div>';
            return;
        }

        container.innerHTML = Object.entries(partitions).map(([name, info]) => `
            <div class="partition-card ${info.is_default ? 'default' : ''}">
                <div class="partition-header">
                    <div class="partition-name">${name}</div>
                    ${info.is_default ? '<div class="partition-badge">Default</div>' : ''}
                    ${info.has_gpu ? '<i class="fas fa-microchip" style="color: var(--info);"></i>' : ''}
                </div>
                <div class="partition-info">
                    <div class="partition-stat">
                        <div class="partition-stat-label">Total Nodes</div>
                        <div class="partition-stat-value">${info.total_nodes}</div>
                    </div>
                    <div class="partition-stat">
                        <div class="partition-stat-label">Idle</div>
                        <div class="partition-stat-value text-success">${info.idle_nodes}</div>
                    </div>
                    <div class="partition-stat">
                        <div class="partition-stat-label">Available CPUs</div>
                        <div class="partition-stat-value">${info.available_cpus}</div>
                    </div>
                    <div class="partition-stat">
                        <div class="partition-stat-label">Time Limit</div>
                        <div class="partition-stat-value">${info.time_limit}</div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    updateNodesTable(nodes) {
        this.debug('Rendering nodes table, total nodes:', nodes.length);
        const tbody = document.getElementById('nodes-table-body');
        
        // Apply filters
        let filteredNodes = nodes.filter(node => {
            // Search filter
            if (this.currentSearch) {
                const searchLower = this.currentSearch.toLowerCase();
                const partitionsStr = (node.partitions || []).join(',').toLowerCase();
                if (!node.name.toLowerCase().includes(searchLower) &&
                    !node.status.toLowerCase().includes(searchLower) &&
                    !(node.gpu_type && node.gpu_type.toLowerCase().includes(searchLower)) &&
                    !partitionsStr.includes(searchLower)) {
                    return false;
                }
            }
            
            // Type filter
            switch (this.currentFilter) {
                case 'idle':
                    return node.status === 'idle';
                case 'gpu':
                    return node.has_gpu;
                case 'available':
                    return node.status === 'idle' || node.status === 'mixed';
                case 'down':
                    return node.status === 'down' || node.status === 'draining';
                default:
                    return true;
            }
        });
        
        // Apply sorting
        if (this.currentSort.field) {
            filteredNodes.sort((a, b) => {
                let aVal = a[this.currentSort.field];
                let bVal = b[this.currentSort.field];
                
                // Handle null/undefined
                if (aVal == null) aVal = '';
                if (bVal == null) bVal = '';
                
                // Compare
                if (typeof aVal === 'string') {
                    return this.currentSort.ascending ? 
                        aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                } else {
                    return this.currentSort.ascending ? 
                        aVal - bVal : bVal - aVal;
                }
            });
        }
        
        if (filteredNodes.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-state"><i class="fas fa-search"></i><p>No nodes found</p></td></tr>';
            return;
        }

        tbody.innerHTML = filteredNodes.map(node => `
            <tr>
                <td><strong>${node.name}</strong></td>
                <td><span class="status-badge status-${node.status}">${node.status}</span></td>
                <td>${node.cpus_free} / ${node.cpus_total}</td>
                <td>${Math.round(node.memory_free / 1024)} GB / ${Math.round(node.memory_total / 1024)} GB</td>
                <td>${node.gpu_type ? node.gpu_type.toUpperCase() : '-'}</td>
                <td>${node.gpu_count || '-'}</td>
                <td>${node.partitions.join(', ')}</td>
            </tr>
        `).join('');

        if (this.debugEnabled && typeof console !== 'undefined') {
            const sample = filteredNodes.slice(0, 10).map(n => {
                const memFree = Math.round(n.memory_free / 1024);
                const memTot = Math.round(n.memory_total / 1024);
                const gpuType = n.gpu_type ? n.gpu_type.toUpperCase() : '-';
                const parts = n.partitions.join(',');
                return `NODE ${n.name} | status=${n.status} | cpu=${n.cpus_free}/${n.cpus_total} | memGB=${memFree}/${memTot} | gpu=${gpuType} x${n.gpu_count || 0} | partitions=${parts}`;
            });
            sample.forEach(line => console.log('[ClusterDashboard]', line));
        }
    }

    updateJobQueue(jobs) {
        this.debug('Rendering jobs table, jobs:', jobs.length);
        this.allJobs = jobs;
        const tbody = document.getElementById('jobs-table-body');
        
        if (jobs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-clock"></i><p>No jobs in queue</p></td></tr>';
            return;
        }

        // Apply filtering
        let filteredJobs = this.filterJobs(jobs);

        if (filteredJobs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="empty-state"><i class="fas fa-search"></i><p>No jobs match the current filters</p></td></tr>';
            return;
        }

        // Apply sorting
        if (this.currentJobSort.field) {
            filteredJobs.sort((a, b) => {
                let aVal = a[this.currentJobSort.field];
                let bVal = b[this.currentJobSort.field];
                
                // Handle null/undefined
                if (aVal == null) aVal = '';
                if (bVal == null) bVal = '';
                
                // Compare
                if (typeof aVal === 'string') {
                    return this.currentJobSort.ascending ? 
                        aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
                } else {
                    return this.currentJobSort.ascending ? 
                        aVal - bVal : bVal - aVal;
                }
            });
        }

        tbody.innerHTML = filteredJobs.map(job => `
            <tr>
                <td><strong>${job.job_id}</strong></td>
                <td>${this.truncate(job.name, 20)}</td>
                <td>${job.user}</td>
                <td><span class="status-badge job-state-${job.state}">${job.state}</span></td>
                <td>${job.time}</td>
                <td>${job.nodes}</td>
                <td>${job.cpus}</td>
                <td>${job.gpus || 0}</td>
                <td>${job.partition}</td>
                <td>${this.truncate(job.node_list, 30)}</td>
            </tr>
        `).join('');

        if (this.debugEnabled && typeof console !== 'undefined') {
            const running = jobs.filter(j => j.state === 'R').length;
            const pending = jobs.filter(j => j.state === 'PD').length;
            console.log('[ClusterDashboard] Jobs summary | total=', jobs.length, '| running=', running, '| pending=', pending, '| filtered=', filteredJobs.length);
            const sample = filteredJobs.slice(0, 10).map(j =>
                `JOB ${j.job_id} | name=${j.name} | user=${j.user} | state=${j.state} | time=${j.time} | nodes=${j.nodes} | cpus=${j.cpus} | gpus=${j.gpus || 0} | part=${j.partition} | node=${j.node_list}`
            );
            sample.forEach(line => console.log('[ClusterDashboard]', line));
        }
    }

    handleSort(field) {
        if (this.currentSort.field === field) {
            this.currentSort.ascending = !this.currentSort.ascending;
        } else {
            this.currentSort.field = field;
            this.currentSort.ascending = true;
        }
        
        this.updateNodesTable(this.allNodes);
    }

    handleFilter(filter) {
        this.currentFilter = filter;
        this.updateNodesTable(this.allNodes);
    }

    handleSearch(search) {
        this.currentSearch = search;
        this.updateNodesTable(this.allNodes);
    }

    handleJobFilter(filter) {
        this.currentJobFilter = filter;
        this.debug('Job filter changed:', filter);
        this.updateJobQueue(this.allJobs);
    }

    handleJobSearch(search) {
        this.currentJobSearch = search;
        this.debug('Job search changed:', search);
        this.updateJobQueue(this.allJobs);
    }

    handleJobSort(field) {
        if (this.currentJobSort.field === field) {
            this.currentJobSort.ascending = !this.currentJobSort.ascending;
        } else {
            this.currentJobSort.field = field;
            this.currentJobSort.ascending = true;
        }
        
        this.updateJobQueue(this.allJobs);
    }

    filterJobs(jobs) {
        let filtered = jobs;

        // Apply state filter
        if (this.currentJobFilter !== 'all') {
            filtered = filtered.filter(job => job.state === this.currentJobFilter);
        }

        // Apply search filter
        if (this.currentJobSearch) {
            const searchLower = String(this.currentJobSearch || '').toLowerCase();
            filtered = filtered.filter(job => {
                const jid = String(job.job_id || '').toLowerCase();
                const name = String(job.name || '').toLowerCase();
                const user = String(job.user || '').toLowerCase();
                const part = String(job.partition || '').toLowerCase();
                const node = String(job.node_list || '').toLowerCase();
                return jid.includes(searchLower) ||
                       name.includes(searchLower) ||
                       user.includes(searchLower) ||
                       part.includes(searchLower) ||
                       node.includes(searchLower);
            });
        }

        return filtered;
    }

    updateLastUpdateTime() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString();
        document.getElementById('last-update-time').textContent = timeStr;
    }

    showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (show) {
            overlay.classList.add('active');
        } else {
            overlay.classList.remove('active');
        }
    }

    showError(message) {
        const errorDiv = document.getElementById('error-message');
        const errorText = document.getElementById('error-text');
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
        
        // Auto-hide after 5 seconds
        setTimeout(() => this.hideError(), 5000);
    }

    hideError() {
        document.getElementById('error-message').classList.add('hidden');
    }

    truncate(str, maxLength) {
        if (!str) return '';
        return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new ClusterDashboard();
});

