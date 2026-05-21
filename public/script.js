// Cluster Monitor Dashboard - Main JavaScript

// Map of raw CPU microarchitecture tokens (as they appear in Slurm
// AvailableFeatures) to human-readable display names. Add new entries
// here when a new node type is onboarded.
const CPU_TYPE_DISPLAY = {
    // Intel
    nehalem: 'Nehalem',
    westmere: 'Westmere',
    sandybridge: 'Sandy Bridge',
    ivybridge: 'Ivy Bridge',
    haswell: 'Haswell',
    broadwell: 'Broadwell',
    skylake: 'Skylake',
    cascadelake: 'Cascade Lake',
    cooperlake: 'Cooper Lake',
    icelake: 'Ice Lake',
    sapphirerapids: 'Sapphire Rapids',
    emeraldrapids: 'Emerald Rapids',
    graniterapids: 'Granite Rapids',
    sierraforest: 'Sierra Forest',
    clearwaterforest: 'Clearwater Forest',
    // AMD
    bulldozer: 'Bulldozer',
    piledriver: 'Piledriver',
    steamroller: 'Steamroller',
    excavator: 'Excavator',
    zen: 'Zen',
    zen2: 'Zen 2',
    zen3: 'Zen 3',
    zen4: 'Zen 4',
    zen5: 'Zen 5',
    naples: 'Naples',
    rome: 'Rome',
    milan: 'Milan',
    genoa: 'Genoa',
    bergamo: 'Bergamo',
    turin: 'Turin',
    // ARM
    neoverse: 'Neoverse',
    graviton: 'Graviton',
    ampere: 'Ampere',
    // Architecture fallbacks (from scontrol Arch=...)
    x86_64: 'x86-64',
    aarch64: 'ARM64',
};

class ClusterDashboard {
    constructor() {
        this.autoRefreshInterval = null;
        this.refreshIntervalMs = 120000;
        this.currentSort = { field: null, ascending: true };
        this.currentFilter = 'all';
        this.currentSearch = '';
        this.currentPartitionScope = 'all';
        this.allNodes = [];
        this.allJobs = [];
        this.allPartitions = {};
        this.scopedNodes = [];
        this.scopedPartitions = {};
        this.scopedStats = {};
        this.lastData = null;
        this.permissions = { can_view_restricted_top_users: false };
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
        document.getElementById('refresh-btn').addEventListener('click', () => this.loadData());
        document.getElementById('auto-refresh-toggle').addEventListener('change', (e) => this.toggleAutoRefresh(e.target.checked));
        document.getElementById('node-search').addEventListener('input', (e) => this.handleSearch(e.target.value));
        document.getElementById('node-filter').addEventListener('change', (e) => this.handleFilter(e.target.value));
        document.getElementById('global-partition-filter').addEventListener('change', (e) => this.handlePartitionScope(e.target.value));

        document.querySelectorAll('thead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => this.handleSort(th.dataset.sort));
        });

        this.loadData();
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
        this.lastData = data;
        this.allNodes = data.nodes || [];
        this.allJobs = data.jobs_raw || [];
        this.allPartitions = data.partitions || {};
        this.permissions = data.permissions || { can_view_restricted_top_users: false };

        this.updatePartitionScopeOptions();
        this.applyPartitionScope(data);
    }

    updatePartitionScopeOptions() {
        const select = document.getElementById('global-partition-filter');
        const names = [...new Set(Object.keys(this.allPartitions || {}))].sort((a, b) => a.localeCompare(b));

        select.innerHTML = ['<option value="all">All Partitions</option>']
            .concat(names.map((name) => `<option value="${name}">${name}</option>`))
            .join('');

        if ([...select.options].some((option) => option.value === this.currentPartitionScope)) {
            select.value = this.currentPartitionScope;
        } else {
            this.currentPartitionScope = 'all';
            select.value = 'all';
        }
    }

    applyPartitionScope(data) {
        const scoped = this.currentPartitionScope === 'all'
            ? this.buildFullScope(data)
            : this.buildPartitionScope(this.currentPartitionScope);

        this.scopedNodes = scoped.nodes;
        this.scopedPartitions = scoped.partitions;
        this.scopedStats = scoped.stats;

        this.debug('Applying partition scope', this.currentPartitionScope, scoped);

        this.updateStats(scoped.stats);
        this.updateGPUCards(scoped.gpuSummary);
        this.updatePartitions(scoped.partitions);
        this.updateTopUsers(scoped.topUsers, scoped.scopeName);
        this.updateNodesTable(scoped.nodes);
    }

    buildFullScope(data) {
        return {
            scopeName: null,
            nodes: this.allNodes,
            partitions: this.allPartitions,
            stats: data.stats || {},
            gpuSummary: data.gpu_summary || {},
            topUsers: []
        };
    }

    buildPartitionScope(partitionName) {
        const nodes = this.allNodes.filter((node) => (node.partitions || []).includes(partitionName));
        const jobs = this.allJobs.filter((job) => job.partition === partitionName);
        const partitions = {};
        if (this.allPartitions[partitionName]) {
            partitions[partitionName] = this.allPartitions[partitionName];
        }

        return {
            scopeName: partitionName,
            nodes,
            partitions,
            stats: this.computeScopedStats(nodes, jobs),
            gpuSummary: this.computeScopedGpuSummary(nodes),
            topUsers: this.computeTopUsers(jobs)
        };
    }

    computeScopedStats(nodes, jobs) {
        const schedulableNodes = nodes.filter((node) => ['idle', 'mixed', 'allocated'].includes(node.status));

        return {
            total_nodes: nodes.length,
            total_cpus: nodes.reduce((sum, node) => sum + (node.cpus_total || 0), 0),
            available_cpus: schedulableNodes.reduce((sum, node) => sum + (node.cpus_free || 0), 0),
            total_memory_mb: nodes.reduce((sum, node) => sum + (node.memory_total || 0), 0),
            available_memory_mb: schedulableNodes.reduce((sum, node) => sum + (node.memory_free || 0), 0),
            total_gpus: nodes.reduce((sum, node) => sum + (node.gpu_count || 0), 0),
            available_gpus: schedulableNodes.reduce((sum, node) => sum + (node.gpu_free || 0), 0),
            total_jobs: jobs.length,
            running_jobs: jobs.filter((job) => job.state === 'R').length,
            pending_jobs: jobs.filter((job) => job.state === 'PD').length
        };
    }

    computeScopedGpuSummary(nodes) {
        const summary = {};
        nodes.filter((node) => node.has_gpu).forEach((node) => {
            const type = node.gpu_type || 'gpu';
            if (!summary[type]) {
                summary[type] = { total: 0, available: 0, in_use: 0, down: 0 };
            }

            summary[type].total += node.gpu_count || 0;

            if (node.status === 'down' || node.status === 'draining') {
                summary[type].down += node.gpu_count || 0;
            } else {
                summary[type].in_use += node.gpu_alloc || 0;
                summary[type].available += node.gpu_free || 0;
            }
        });

        return summary;
    }

    computeTopUsers(jobs) {
        const users = {};

        jobs.forEach((job) => {
            if (!job.user) return;

            users[job.user] ||= { user: job.user, jobs: 0, running: 0, pending: 0, gpus: 0 };
            users[job.user].jobs += 1;
            users[job.user].running += job.state === 'R' ? 1 : 0;
            users[job.user].pending += job.state === 'PD' ? 1 : 0;
            users[job.user].gpus += job.gpus || 0;
        });

        return Object.values(users)
            .sort((a, b) => {
                if (b.jobs !== a.jobs) return b.jobs - a.jobs;
                if (b.running !== a.running) return b.running - a.running;
                return a.user.localeCompare(b.user);
            })
            .slice(0, 8);
    }

    updateStats(stats) {
        this.debug('Stats update', stats);
        document.getElementById('stat-total-nodes').textContent = stats.total_nodes;
        document.getElementById('stat-available-cpus').textContent = stats.available_cpus;
        document.getElementById('stat-total-cpus').textContent = `of ${stats.total_cpus} total`;

        const availMemGB = (stats.available_memory_mb || 0) / 1024;
        const totalMemGB = (stats.total_memory_mb || 0) / 1024;
        const formatMem = (gb) => gb >= 1024
            ? `${(gb / 1024).toFixed(1)} TB`
            : `${Math.round(gb)} GB`;
        document.getElementById('stat-available-memory').textContent = formatMem(availMemGB);
        document.getElementById('stat-total-memory').textContent = `of ${formatMem(totalMemGB)} total`;

        const totalGpus = stats.total_gpus || 0;
        const gpusCard = document.getElementById('stat-gpus-card');
        if (totalGpus > 0) {
            gpusCard.classList.remove('hidden');
            document.getElementById('stat-available-gpus').textContent = stats.available_gpus || 0;
            document.getElementById('stat-total-gpus').textContent = `of ${totalGpus} total`;
        } else {
            gpusCard.classList.add('hidden');
        }

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

        const gradients = [
            ['#667eea', '#764ba2'],
            ['#f093fb', '#f5576c'],
            ['#0083B0', '#00B4DB'],
            ['#11998e', '#38ef7d'],
            ['#fa709a', '#fee140'],
            ['#30cfd0', '#330867'],
            ['#a18cd1', '#fbc2eb'],
            ['#ff9a9e', '#fad0c4'],
        ];
        let colorIndex = 0;

        container.innerHTML = Object.entries(gpuSummary).map(([type, stats]) => {
            const total = stats.total;
            const available = stats.available;
            const inUse = stats.in_use;
            const down = stats.down;
            const usagePercent = total > 0 ? Math.round((inUse / total) * 100) : 0;

            const [color1, color2] = gradients[colorIndex % gradients.length];
            colorIndex++;

            return `
                <div class="gpu-card" style="background: linear-gradient(135deg, ${color1} 0%, ${color2} 100%);" title="${type.toUpperCase()} — ${available} of ${total} GPUs available${down > 0 ? `, ${down} down` : ''}">
                    <div class="gpu-card-header">
                        <div class="gpu-type">${type.toUpperCase()}</div>
                        <div class="gpu-icon"><i class="fas fa-microchip"></i></div>
                    </div>
                    <div class="gpu-main">
                        <span class="gpu-main-value">${available}</span>
                        <span class="gpu-main-total">/ ${total}</span>
                    </div>
                    <div class="gpu-main-label">Available</div>
                    <div class="gpu-progress">
                        <div class="gpu-progress-bar" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="gpu-meta">
                        <span class="gpu-meta-item"><strong>${inUse}</strong> in use · ${usagePercent}%</span>
                        ${down > 0
                            ? `<span class="gpu-meta-item gpu-meta-down"><i class="fas fa-circle-exclamation"></i> <strong>${down}</strong> down</span>`
                            : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    updatePartitions(partitions) {
        this.debug('Partitions summary', partitions);
        const container = document.getElementById('partition-cards');
        const entries = Object.entries(partitions || {});

        if (entries.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-layer-group"></i><p>No partitions found</p></div>';
            return;
        }

        container.innerHTML = entries.map(([name, info]) => {
            const totalCpus = info.total_cpus || 0;
            const availCpus = info.available_cpus || 0;
            const usedCpus = Math.max(totalCpus - availCpus, 0);
            const usagePercent = totalCpus > 0 ? Math.round((usedCpus / totalCpus) * 100) : 0;
            const classes = ['partition-card'];
            if (info.is_default) classes.push('default');
            if (info.has_gpu) classes.push('has-gpu');

            return `
                <div class="${classes.join(' ')}" title="${name} — ${availCpus} of ${totalCpus} CPUs available">
                    <div class="partition-header">
                        <div class="partition-name">${name}</div>
                        <div class="partition-tags">
                            ${info.is_default ? '<span class="partition-badge">Default</span>' : ''}
                            ${info.has_gpu ? '<span class="partition-icon" title="GPU partition"><i class="fas fa-microchip"></i></span>' : ''}
                        </div>
                    </div>
                    <div class="partition-main">
                        <span class="partition-main-value">${availCpus}</span>
                        <span class="partition-main-total">/ ${totalCpus}</span>
                    </div>
                    <div class="partition-main-label">CPUs Available</div>
                    <div class="partition-progress">
                        <div class="partition-progress-bar" style="width: ${usagePercent}%"></div>
                    </div>
                    <div class="partition-meta">
                        <span class="partition-meta-item"><i class="fas fa-server"></i> <strong>${info.idle_nodes}</strong>/${info.total_nodes} idle</span>
                        <span class="partition-meta-item"><i class="far fa-clock"></i> ${info.time_limit}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    updateTopUsers(topUsers, scopeName) {
        const section = document.getElementById('top-users-section');
        const container = document.getElementById('top-users-content');

        if (this.currentPartitionScope === 'all' || !this.permissions.can_view_restricted_top_users) {
            section.classList.add('hidden');
            container.innerHTML = '';
            return;
        }

        section.classList.remove('hidden');

        if (!topUsers.length) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i><p>No jobs currently visible in ${scopeName}</p></div>`;
            return;
        }

        container.innerHTML = topUsers.map((entry) => `
            <div class="top-user-card">
                <div class="top-user-name">${entry.user}</div>
                <div class="top-user-metrics">
                    <span>${entry.jobs} jobs</span>
                    <span>${entry.running} running</span>
                    <span>${entry.pending} pending</span>
                    ${entry.gpus > 0 ? `<span>${entry.gpus} GPUs</span>` : ''}
                </div>
            </div>
        `).join('');
    }

    updateNodesTable(nodes) {
        this.debug('Rendering nodes table, total nodes:', nodes.length);
        const tbody = document.getElementById('nodes-table-body');

        let filteredNodes = nodes.filter(node => {
            if (this.currentSearch) {
                const searchLower = this.currentSearch.toLowerCase();
                const partitionsStr = (node.partitions || []).join(',').toLowerCase();
                if (!node.name.toLowerCase().includes(searchLower) &&
                    !node.status.toLowerCase().includes(searchLower) &&
                    !(node.cpu_type && node.cpu_type.toLowerCase().includes(searchLower)) &&
                    !(node.gpu_type && node.gpu_type.toLowerCase().includes(searchLower)) &&
                    !partitionsStr.includes(searchLower)) {
                    return false;
                }
            }

            switch (this.currentFilter) {
                case 'idle':
                    return node.status === 'idle';
                case 'gpu':
                    return node.has_gpu;
                case 'available':
                    return node.status === 'idle' || node.status === 'mixed';
                case 'down':
                    return node.status === 'down' || node.status === 'draining';
                case 'reserved':
                    return node.reservations && node.reservations.some(r => r.state === 'ACTIVE');
                default:
                    return true;
            }
        });

        if (this.currentSort.field) {
            filteredNodes.sort((a, b) => {
                let aVal = a[this.currentSort.field];
                let bVal = b[this.currentSort.field];

                if (aVal == null) aVal = '';
                if (bVal == null) bVal = '';

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
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="fas fa-search"></i><p>No nodes found</p></td></tr>';
            return;
        }

        const formatCpuType = (t) => {
            if (!t) return '-';
            const pretty = CPU_TYPE_DISPLAY[t.toLowerCase()];
            if (pretty) return pretty;
            // Fallback: capitalize first letter for unknown codenames
            return t.charAt(0).toUpperCase() + t.slice(1);
        };

        tbody.innerHTML = filteredNodes.map(node => `
            <tr>
                <td><strong>${node.name}</strong></td>
                <td><span class="status-badge status-${node.status}">${node.status}</span></td>
                <td>${formatCpuType(node.cpu_type)}</td>
                <td>${node.cpus_free} / ${node.cpus_total}</td>
                <td>${Math.round(node.memory_free / 1024)} GB / ${Math.round(node.memory_total / 1024)} GB</td>
                <td>${node.gpu_type ? node.gpu_type.toUpperCase() : '-'}</td>
                <td>${node.gpu_count ? `${node.gpu_free} / ${node.gpu_count}` : '-'}</td>
                <td>${node.partitions.join(', ')}</td>
            </tr>
        `).join('');
    }

    handleSort(field) {
        if (this.currentSort.field === field) {
            this.currentSort.ascending = !this.currentSort.ascending;
        } else {
            this.currentSort.field = field;
            this.currentSort.ascending = true;
        }

        this.updateNodesTable(this.scopedNodes);
    }

    handleFilter(filter) {
        this.currentFilter = filter;
        this.updateNodesTable(this.scopedNodes);
    }

    handleSearch(search) {
        this.currentSearch = search;
        this.updateNodesTable(this.scopedNodes);
    }

    handlePartitionScope(scope) {
        this.currentPartitionScope = scope;
        if (this.lastData) {
            this.applyPartitionScope(this.lastData);
        }
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

        setTimeout(() => this.hideError(), 5000);
    }

    hideError() {
        document.getElementById('error-message').classList.add('hidden');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new ClusterDashboard();
});
