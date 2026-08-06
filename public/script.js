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

// Sentinel used by the GPU drill-down to mean "any GPU type".
const ALL_GPU_TYPES = '__all_gpu_types__';

// Gres name used when a site configures GPUs without a model name ("Gres=gpu:4").
// Such nodes are requested as --gres=gpu:N, with no model segment.
const UNTYPED_GPU = 'gpu';

// Partitions we prefer to suggest in a generated srun hint, in order. Only used
// when the user has not selected a partition explicitly.
const PREFERRED_GPU_PARTITIONS = ['gpu', 'gpu-preempt', 'preempt', 'interactive'];
const PREFERRED_CPU_PARTITIONS = ['batch', 'mpi', 'largemem', 'interactive', 'preempt'];

// Cap on how many partition routes to list for one GPU type, so a node that
// belongs to many partitions cannot flood the panel.
const MAX_PARTITION_HINTS = 4;

// Partitions whose jobs can be preempted. This is deliberately an explicit list
// rather than something derived from Slurm's PreemptMode: `scontrol show
// partition` reports the cluster-wide default for any partition that does not set
// its own, which made every partition look preemptible. Add names here if the
// site gains another preemptible partition.
const PREEMPTIBLE_PARTITIONS = ['preempt'];

function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Render a Slurm comma list (e.g. "linlab,tts_rsch_hpc_admin") as readable prose:
// "linlab or tts_rsch_hpc_admin". Each item is escaped individually so the
// separators stay literal.
function formatNameList(value) {
    const parts = String(value == null ? '' : value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map(escapeHtml);

    if (parts.length <= 1) return parts.join('');
    if (parts.length === 2) return parts.join(' or ');
    return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

class ClusterDashboard {
    constructor() {
        this.autoRefreshInterval = null;
        this.refreshIntervalMs = 120000;
        this.currentSort = { field: null, ascending: true };
        this.currentFilter = 'all';
        this.currentSearch = '';
        this.currentPartitionScope = 'all';
        // Drill-down state. Exactly one card may be selected at a time:
        // `gpuTypeFilter` holds a specific GPU type (e.g. "a100-80G") or the
        // sentinel ALL_GPU_TYPES, `partitionFilter` holds a partition name, and
        // selecting either clears the other.
        this.gpuTypeFilter = null;
        this.partitionFilter = null;
        this.gpuAvailableOnly = true;
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

        this.initDrilldown();

        this.loadData();
        this.toggleAutoRefresh(true);
    }

    // ---------------------------------------------------------------------
    // GPU drill-down
    // ---------------------------------------------------------------------

    // Cards are re-rendered on every refresh, so all handlers are delegated
    // from stable containers rather than bound to individual cards.
    initDrilldown() {
        this.bindCardActivation('gpu-cards', '.gpu-card[data-gpu-type]',
            (card) => this.toggleGpuTypeFilter(card.dataset.gpuType));

        this.bindCardActivation('partition-cards', '.partition-card[data-partition]',
            (card) => this.togglePartitionFilter(card.dataset.partition));

        const gpuStatCard = document.getElementById('stat-gpus-card');
        gpuStatCard.addEventListener('click', () => this.toggleGpuTypeFilter(ALL_GPU_TYPES));
        gpuStatCard.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.toggleGpuTypeFilter(ALL_GPU_TYPES);
        });

        const panel = document.getElementById('drilldown-panel');
        panel.addEventListener('click', (event) => {
            if (event.target.closest('[data-action="clear-drilldown"]')) {
                this.clearDrilldown();
                return;
            }

            const scopeBtn = event.target.closest('[data-action="scope-partition"]');
            if (scopeBtn) {
                this.scopeToPartition(scopeBtn.dataset.partition);
                return;
            }

            const copyBtn = event.target.closest('[data-action="copy-hint"]');
            if (copyBtn) {
                this.copyToClipboard(copyBtn.dataset.copy, copyBtn);
                return;
            }

            const chip = event.target.closest('[data-node-name]');
            if (chip) this.focusNode(chip.dataset.nodeName);
        });

        panel.addEventListener('change', (event) => {
            if (event.target.id === 'drilldown-available-only') {
                this.gpuAvailableOnly = event.target.checked;
                this.updateNodesTable(this.scopedNodes);
            }
        });
    }

    // Wire click + Enter/Space on a re-rendered card grid.
    bindCardActivation(containerId, selector, activate) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.addEventListener('click', (event) => {
            const card = event.target.closest(selector);
            if (card) activate(card);
        });

        container.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const card = event.target.closest(selector);
            if (!card) return;
            event.preventDefault();
            activate(card);
        });
    }

    // A stale text search or status filter would silently hide the very nodes
    // the user just asked to see, so reset them whenever a card is selected.
    resetTableFilters() {
        this.currentSearch = '';
        document.getElementById('node-search').value = '';
        this.currentFilter = 'all';
        document.getElementById('node-filter').value = 'all';
    }

    toggleGpuTypeFilter(type) {
        if (!type) return;

        if (this.gpuTypeFilter === type) {
            this.clearGpuTypeFilter();
            return;
        }

        // One selection at a time: picking a GPU card drops any partition card.
        this.gpuTypeFilter = type;
        this.partitionFilter = null;
        this.gpuAvailableOnly = true;
        this.resetTableFilters();

        // Most-available nodes first — that is what the user is looking for.
        this.currentSort = { field: 'gpu_free', ascending: false };

        this.refreshDrilldown({ scroll: true });
    }

    togglePartitionFilter(name) {
        if (!name) return;

        if (this.partitionFilter === name) {
            this.clearPartitionFilter();
            return;
        }

        // One selection at a time: picking a partition card drops any GPU card.
        this.partitionFilter = name;
        this.gpuTypeFilter = null;
        this.gpuAvailableOnly = true;
        this.resetTableFilters();
        this.currentSort = { field: 'cpus_free', ascending: false };

        this.refreshDrilldown({ scroll: true });
    }

    clearGpuTypeFilter() {
        this.gpuTypeFilter = null;
        this.refreshDrilldown();
    }

    clearPartitionFilter() {
        this.partitionFilter = null;
        this.refreshDrilldown();
    }

    clearDrilldown() {
        this.gpuTypeFilter = null;
        this.partitionFilter = null;
        this.refreshDrilldown();
    }

    // The "Available GPUs" stat card doubles as the all-GPU-types selector, so its
    // pressed state has to track the filter on every drill-down change — not only
    // when the stats are re-rendered from new data.
    updateGpuStatCardSelection() {
        const card = document.getElementById('stat-gpus-card');
        if (!card) return;
        const selected = this.gpuTypeFilter === ALL_GPU_TYPES;
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-pressed', String(selected));
    }

    // Re-render everything that reflects drill-down state.
    refreshDrilldown({ scroll = false } = {}) {
        this.renderGpuCards(this.lastGpuSummary || {});
        this.renderPartitionCards(this.scopedPartitions || {});
        this.updateGpuStatCardSelection();
        this.updateNodesTable(this.scopedNodes);
        if (scroll) this.scrollToNodes();
    }

    // Escalate a partition drill-down into the global scope, which also
    // rescopes the stat cards, GPU cards and active-user list.
    scopeToPartition(name) {
        if (!name) return;

        this.partitionFilter = null;
        this.currentPartitionScope = name;

        const select = document.getElementById('global-partition-filter');
        if (select && [...select.options].some((option) => option.value === name)) {
            select.value = name;
        }

        if (this.lastData) this.applyPartitionScope(this.lastData);
        this.scrollToNodes();
    }

    scrollToNodes() {
        const section = document.getElementById('nodes-section');
        if (section && typeof section.scrollIntoView === 'function') {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Highlight a single node row and bring it into view.
    focusNode(nodeName) {
        const row = document.querySelector(`#nodes-table-body tr[data-node-name="${CSS.escape(nodeName)}"]`);
        if (!row) return;

        document.querySelectorAll('#nodes-table-body tr.row-flash')
            .forEach((el) => el.classList.remove('row-flash'));
        row.classList.add('row-flash');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => row.classList.remove('row-flash'), 2000);
    }

    async copyToClipboard(text, button) {
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            // Clipboard API needs a secure context; fall back to a hidden textarea.
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try { document.execCommand('copy'); } catch (e) { /* nothing else to try */ }
            document.body.removeChild(textarea);
        }

        if (button) {
            const original = button.innerHTML;
            button.innerHTML = '<i class="fas fa-check"></i> Copied';
            button.classList.add('copied');
            setTimeout(() => {
                button.innerHTML = original;
                button.classList.remove('copied');
            }, 1600);
        }
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
        this.lastGpuSummary = scoped.gpuSummary || {};

        // Drop a drill-down selection that no longer exists in this scope (e.g.
        // the user switched to a partition without those GPUs).
        const gpuTypes = Object.keys(this.lastGpuSummary);
        if (this.gpuTypeFilter === ALL_GPU_TYPES) {
            if (gpuTypes.length === 0) this.gpuTypeFilter = null;
        } else if (this.gpuTypeFilter && !gpuTypes.includes(this.gpuTypeFilter)) {
            this.gpuTypeFilter = null;
        }

        if (this.partitionFilter && !Object.keys(this.scopedPartitions).includes(this.partitionFilter)) {
            this.partitionFilter = null;
        }

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
        this.updateGpuStatCardSelection();

        document.getElementById('stat-running-jobs').textContent = stats.running_jobs;
        document.getElementById('stat-total-jobs').textContent = `${stats.total_jobs} total jobs`;
    }

    updateGPUCards(gpuSummary) {
        this.debug('GPU summary', gpuSummary);
        this.renderGpuCards(gpuSummary);
    }

    renderGpuCards(gpuSummary) {
        const container = document.getElementById('gpu-cards');

        // Cards are replaced wholesale, which would drop keyboard focus (and so
        // break repeated Enter/Space presses). Remember which card was focused
        // and restore it after the rebuild.
        const focusedCard = document.activeElement
            && document.activeElement.closest
            && document.activeElement.closest('#gpu-cards .gpu-card[data-gpu-type]');
        const focusedType = focusedCard ? focusedCard.dataset.gpuType : null;

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

            const selected = this.gpuTypeFilter === type;
            const label = escapeHtml(type.toUpperCase());

            // Nodes of this type that clicking the card would list. Counted from
            // the node data (not the GPU totals) so the label matches the table.
            const typeNodes = this.scopedNodes.filter((node) => node.has_gpu
                && (node.gpu_type || 'gpu') === type
                && (!this.partitionFilter || (node.partitions || []).includes(this.partitionFilter)));
            const freeNodeCount = typeNodes.filter((node) => (node.gpu_free || 0) > 0).length;

            const actionText = selected
                ? '<i class="fas fa-circle-xmark"></i> Clear filter'
                : (freeNodeCount > 0
                    ? `<i class="fas fa-filter"></i> Show ${freeNodeCount} of ${plural(typeNodes.length, 'node')} with free GPUs`
                    : `<i class="fas fa-filter"></i> Show all ${plural(typeNodes.length, 'node')} of this type`);

            return `
                <div class="gpu-card clickable-card${selected ? ' selected' : ''}"
                     data-gpu-type="${escapeHtml(type)}"
                     role="button" tabindex="0" aria-pressed="${selected}"
                     style="background: linear-gradient(135deg, ${color1} 0%, ${color2} 100%);"
                     title="${label} — ${available} of ${total} GPUs available${down > 0 ? `, ${down} down` : ''}. Click to ${selected ? 'clear the filter' : 'list the nodes'}.">
                    <div class="gpu-card-header">
                        <div class="gpu-type">${label}</div>
                        <div class="gpu-icon"><i class="fas ${selected ? 'fa-circle-check' : 'fa-microchip'}"></i></div>
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
                    <div class="gpu-card-action">${actionText}</div>
                </div>
            `;
        }).join('');

        if (focusedType) {
            const restored = container.querySelector(`.gpu-card[data-gpu-type="${CSS.escape(focusedType)}"]`);
            // preventScroll so restoring focus does not fight the smooth scroll
            // down to the node table.
            if (restored) restored.focus({ preventScroll: true });
        }
    }

    updatePartitions(partitions) {
        this.debug('Partitions summary', partitions);
        this.renderPartitionCards(partitions);
    }

    renderPartitionCards(partitions) {
        const container = document.getElementById('partition-cards');
        const entries = Object.entries(partitions || {});

        // Same focus-preservation problem as the GPU grid: the cards are
        // replaced wholesale on every render.
        const focusedCard = document.activeElement
            && document.activeElement.closest
            && document.activeElement.closest('#partition-cards .partition-card[data-partition]');
        const focusedPartition = focusedCard ? focusedCard.dataset.partition : null;

        if (entries.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-layer-group"></i><p>No partitions found</p></div>';
            return;
        }

        container.innerHTML = entries.map(([name, info]) => {
            const totalCpus = info.total_cpus || 0;
            const availCpus = info.available_cpus || 0;
            const usedCpus = Math.max(totalCpus - availCpus, 0);
            const usagePercent = totalCpus > 0 ? Math.round((usedCpus / totalCpus) * 100) : 0;
            const selected = this.partitionFilter === name;
            const safeName = escapeHtml(name);

            // Match what clicking actually lists: nodes with spare capacity of
            // either kind, not the partition's whole node count.
            const partitionNodes = this.scopedNodes.filter((node) => (node.partitions || []).includes(name));
            const freeNodeCount = partitionNodes.filter(
                (node) => (node.cpus_free || 0) > 0 || (node.gpu_free || 0) > 0
            ).length;

            const actionText = selected
                ? '<i class="fas fa-circle-xmark"></i> Clear filter'
                : (freeNodeCount > 0
                    ? `<i class="fas fa-filter"></i> Show ${freeNodeCount} of ${plural(partitionNodes.length, 'node')} with capacity`
                    : `<i class="fas fa-filter"></i> Show all ${plural(partitionNodes.length, 'node')}`);

            return `
                <div class="partition-card clickable-card ${info.is_default ? 'default' : ''}${selected ? ' selected' : ''}"
                     data-partition="${safeName}"
                     role="button" tabindex="0" aria-pressed="${selected}"
                     title="${safeName} — ${availCpus} of ${totalCpus} CPUs available. Click to ${selected ? 'clear the filter' : 'list its nodes'}.">
                    <div class="partition-header">
                        <div class="partition-name">${safeName}</div>
                        <div class="partition-tags">
                            ${selected ? '<i class="fas fa-circle-check partition-selected-icon"></i>' : ''}
                            ${info.is_default ? '<span class="partition-badge">Default</span>' : ''}
                            ${info.has_gpu ? '<i class="fas fa-microchip partition-gpu-icon" title="GPU partition"></i>' : ''}
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
                        <span class="partition-meta-item"><i class="far fa-clock"></i> ${escapeHtml(info.time_limit)}</span>
                    </div>
                    <div class="partition-card-action">${actionText}</div>
                </div>
            `;
        }).join('');

        if (focusedPartition) {
            const restored = container.querySelector(`.partition-card[data-partition="${CSS.escape(focusedPartition)}"]`);
            if (restored) restored.focus({ preventScroll: true });
        }
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

        // The drill-down runs first so the panel always reflects the selected
        // cards, independent of the search box and status dropdown.
        const matchedNodes = this.applyDrilldownFilter(nodes);
        this.updateDrilldownPanel(matchedNodes, this.drilldownCapabilityNodes(nodes));

        let filteredNodes = matchedNodes.filter(node => {
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
            const message = this.hasDrilldown()
                ? `No nodes match ${this.drilldownLabel()} plus the current search and status filters`
                : 'No nodes found';
            tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><i class="fas fa-search"></i><p>${escapeHtml(message)}</p></td></tr>`;
            return;
        }

        const formatCpuType = (t) => {
            if (!t) return '-';
            const pretty = CPU_TYPE_DISPLAY[t.toLowerCase()];
            if (pretty) return pretty;
            // Fallback: capitalize first letter for unknown codenames
            return t.charAt(0).toUpperCase() + t.slice(1);
        };

        // When drilling down, the metric the user is shopping for gets emphasis.
        const highlightMetric = this.gpuTypeFilter ? 'gpu' : (this.partitionFilter ? 'cpu' : null);

        tbody.innerHTML = filteredNodes.map(node => {
            const reserved = (node.reservations || []).some(r => r.state === 'ACTIVE');
            const freeGpus = node.gpu_free || 0;
            const freeCpus = node.cpus_free || 0;
            const gpuCell = node.gpu_count
                ? `<span class="gpu-count ${freeGpus > 0 ? 'gpu-count-free' : 'gpu-count-busy'}">${freeGpus} / ${node.gpu_count}</span>`
                : '-';

            const highlighted = (highlightMetric === 'gpu' && freeGpus > 0)
                || (highlightMetric === 'cpu' && freeCpus > 0);

            return `
            <tr data-node-name="${escapeHtml(node.name)}"${highlighted ? ' class="row-gpu-available"' : ''}>
                <td>
                    <strong>${escapeHtml(node.name)}</strong>
                    ${reserved ? '<i class="fas fa-lock node-reserved-icon" title="This node has an ACTIVE reservation and may not be available to you"></i>' : ''}
                </td>
                <td><span class="status-badge status-${node.status}">${node.status}</span></td>
                <td>${formatCpuType(node.cpu_type)}</td>
                <td>${freeCpus} / ${node.cpus_total}</td>
                <td>${Math.round(node.memory_free / 1024)} GB / ${Math.round(node.memory_total / 1024)} GB</td>
                <td>${node.gpu_type ? escapeHtml(node.gpu_type.toUpperCase()) : '-'}</td>
                <td>${gpuCell}</td>
                <td>${escapeHtml((node.partitions || []).join(', '))}</td>
            </tr>
        `;
        }).join('');
    }

    // ---------------------------------------------------------------------
    // Drill-down: filtering + summary panel
    // ---------------------------------------------------------------------

    hasDrilldown() {
        return Boolean(this.gpuTypeFilter || this.partitionFilter);
    }

    gpuLabel() {
        if (!this.gpuTypeFilter) return '';
        return this.gpuTypeFilter === ALL_GPU_TYPES ? 'All GPU types' : this.gpuTypeFilter.toUpperCase();
    }

    // Human-readable description of the whole selection, for empty states.
    drilldownLabel() {
        const parts = [];
        if (this.gpuTypeFilter) parts.push(this.gpuLabel());
        if (this.partitionFilter) parts.push(`partition ${this.partitionFilter}`);
        return parts.join(' in ');
    }

    // The resource the "only available" toggle applies to: GPUs when a GPU type
    // is selected, otherwise CPUs.
    drilldownResource() {
        return this.gpuTypeFilter ? 'gpu' : 'cpu';
    }

    // Does this node match the selected cards, ignoring current availability?
    matchesDrilldown(node) {
        if (this.partitionFilter && !(node.partitions || []).includes(this.partitionFilter)) return false;

        if (this.gpuTypeFilter) {
            if (!node.has_gpu) return false;
            if (this.gpuTypeFilter !== ALL_GPU_TYPES && node.gpu_type !== this.gpuTypeFilter) return false;
        }

        return true;
    }

    applyDrilldownFilter(nodes) {
        if (!this.hasDrilldown()) return nodes;

        const resource = this.drilldownResource();

        return nodes.filter((node) => {
            if (!this.matchesDrilldown(node)) return false;

            if (this.gpuAvailableOnly) {
                if (resource === 'gpu') return (node.gpu_free || 0) > 0;
                // Partition-only selection: a GPU node whose CPUs are all
                // allocated still has free GPUs worth knowing about, so treat
                // spare capacity of either kind as "available". Filtering on
                // free CPUs alone hid every busy GPU node from a GPU partition.
                return (node.cpus_free || 0) > 0 || (node.gpu_free || 0) > 0;
            }

            return true;
        });
    }

    // Nodes used to decide *which example commands to show*. This deliberately
    // ignores the availability toggle: the command list describes what the
    // selection can be asked for, not what happens to be free this second.
    // Down/draining nodes are still excluded — nothing can be scheduled on them.
    drilldownCapabilityNodes(nodes) {
        return nodes.filter((node) => this.matchesDrilldown(node)
            && ['idle', 'mixed', 'allocated'].includes(node.status));
    }

    // Build one example `srun` per distinct thing the current selection can
    // actually give you. A partition holding CPU-only nodes plus two GPU models
    // yields three commands, because a single command cannot represent them:
    // `--gres=gpu:a100:1` is invalid on a CPU node and on a V100 node.
    buildSrunHints(capabilityNodes) {
        if (!capabilityNodes.length) return [];

        // A specific GPU type was selected. The same nodes are often reachable
        // through more than one partition — a contributed lab partition and the
        // cluster-wide preempt partition, for instance — and which one you may
        // use depends on your group, so list a command per route.
        if (this.gpuTypeFilter && this.gpuTypeFilter !== ALL_GPU_TYPES) {
            return this.gpuHintsByPartition(this.gpuTypeFilter, capabilityNodes);
        }

        const hints = [];

        // CPU-only nodes are a distinct case and only relevant when the user did
        // not ask for GPUs at all.
        const cpuNodes = capabilityNodes.filter((node) => !node.has_gpu);
        if (!this.gpuTypeFilter && cpuNodes.length) {
            const partition = this.hintPartition(cpuNodes, PREFERRED_CPU_PARTITIONS);
            if (partition) {
                const freeCpus = cpuNodes.reduce((sum, node) => sum + (node.cpus_free || 0), 0);
                const totalCpus = cpuNodes.reduce((sum, node) => sum + (node.cpus_total || 0), 0);
                hints.push({
                    tag: 'CPU only',
                    detail: `${freeCpus} of ${totalCpus} CPUs free on ${cpuNodes.length} node${cpuNodes.length === 1 ? '' : 's'}`,
                    cmd: `srun -p ${partition} -N 1 -c 4 --mem=8G --pty bash`
                });
            }
        }

        // One command per GPU model present, most-available first. Nodes with an
        // untyped GRES report gpu_type "gpu"; fall back defensively in case an
        // older backend response omits it entirely.
        const byType = new Map();
        capabilityNodes.filter((node) => node.has_gpu).forEach((node) => {
            const type = node.gpu_type || 'gpu';
            if (!byType.has(type)) byType.set(type, []);
            byType.get(type).push(node);
        });

        const freeGpusOf = (list) => list.reduce((sum, node) => sum + (node.gpu_free || 0), 0);

        [...byType.entries()]
            .sort((a, b) => freeGpusOf(b[1]) - freeGpusOf(a[1]) || a[0].localeCompare(b[0]))
            .forEach(([type, typeNodes]) => {
                const hint = this.gpuSrunHint(type, typeNodes);
                if (hint) hints.push(hint);
            });

        return hints;
    }

    partitionInfoFor(name) {
        // allPartitions rather than scopedPartitions: a GPU type's partitions can
        // fall outside the current scope, and access rules are scope-independent.
        return (this.allPartitions || {})[name] || {};
    }

    // Limited to a lab/group. Note this says nothing about whether the *nodes*
    // are usable: contributed nodes are normally also in a preemptible partition
    // that everyone may submit to.
    isOwnerOnlyPartition(name) {
        return Boolean(this.partitionInfoFor(name).owner_only);
    }

    isPreemptiblePartition(name) {
        return PREEMPTIBLE_PARTITIONS.includes(name);
    }

    // One command per partition that reaches this GPU type. Routes everyone can
    // submit to come first; a lab's own partition is listed after, since only its
    // members can use it — but the nodes themselves are reachable either way.
    gpuHintsByPartition(refinedType, capabilityNodes) {
        const typeNodes = capabilityNodes.filter(
            (node) => node.has_gpu && (node.gpu_type || 'gpu') === refinedType
        );
        if (!typeNodes.length) return [];

        const byPartition = new Map();
        typeNodes.forEach((node) => (node.partitions || []).forEach((name) => {
            if (!byPartition.has(name)) byPartition.set(name, []);
            byPartition.get(name).push(node);
        }));
        if (!byPartition.size) return [];

        const freeGpusOf = (list) => list.reduce((sum, node) => sum + (node.gpu_free || 0), 0);
        const rank = (name) => {
            const index = PREFERRED_GPU_PARTITIONS.indexOf(name);
            return index === -1 ? PREFERRED_GPU_PARTITIONS.length : index;
        };

        const ordered = [...byPartition.entries()].sort((a, b) => {
            const ownerDiff = (this.isOwnerOnlyPartition(a[0]) ? 1 : 0)
                - (this.isOwnerOnlyPartition(b[0]) ? 1 : 0);
            if (ownerDiff) return ownerDiff;
            if (rank(a[0]) !== rank(b[0])) return rank(a[0]) - rank(b[0]);
            return freeGpusOf(b[1]) - freeGpusOf(a[1]) || a[0].localeCompare(b[0]);
        });

        const hints = ordered
            .slice(0, MAX_PARTITION_HINTS)
            .map(([name, nodes]) => this.gpuSrunHint(refinedType, nodes, name))
            .filter(Boolean);

        if (ordered.length > MAX_PARTITION_HINTS) {
            hints.overflow = ordered.length - MAX_PARTITION_HINTS;
        }

        return hints;
    }

    // One GPU command for a single model. The partition is resolved from that
    // model's own nodes: picking a partition across all GPU types could pair
    // `-p mpi` with an H100 that only exists in `gpu`.
    gpuSrunHint(refinedType, typeNodes, partitionOverride = null) {
        const nodes = typeNodes.filter((node) => node.has_gpu && (node.gpu_type || 'gpu') === refinedType);
        if (!nodes.length) return null;

        // Fall back to the display type when the backend predates gpu_base_type.
        const bases = [...new Set(nodes.map((n) => n.gpu_base_type || n.gpu_type || 'gpu'))];
        // Mixed Gres names under one display type cannot be expressed as one
        // command; use the most common so the user still gets something usable.
        const base = bases.length === 1 ? bases[0] : this.mostCommon(nodes.map((n) => n.gpu_base_type || n.gpu_type || 'gpu'));

        const partition = partitionOverride || this.hintPartition(nodes, PREFERRED_GPU_PARTITIONS);
        if (!partition) return null;

        // The refined display type (e.g. "a100-80G") is a node *feature*, not a
        // Gres name, so it has to be requested via --constraint instead.
        const needsConstraint = refinedType.toLowerCase() !== base.toLowerCase();
        const freeGpus = nodes.reduce((sum, node) => sum + (node.gpu_free || 0), 0);
        const totalGpus = nodes.reduce((sum, node) => sum + (node.gpu_count || 0), 0);

        // Untyped GRES takes no model segment: --gres=gpu:1, not --gres=gpu:gpu:1.
        const gresSpec = base === UNTYPED_GPU ? 'gpu:1' : `gpu:${base}:1`;

        let cmd = `srun -p ${partition} -N 1 -c 4 --gres=${gresSpec}`;
        if (needsConstraint) cmd += ` --constraint=${refinedType}`;
        cmd += ' --pty bash';

        const info = this.partitionInfoFor(partition);

        return {
            // When fanning a single GPU type out across partitions the type is
            // already on the filter chip, so the partition is the useful label.
            tag: partitionOverride ? partition : refinedType.toUpperCase(),
            detail: `${freeGpus} of ${totalGpus} GPUs free on ${plural(nodes.length, 'node')}`,
            partition,
            ownerOnly: Boolean(info.owner_only),
            preemptible: Boolean(info.preemptible),
            allowGroups: info.allow_groups || null,
            allowAccounts: info.allow_accounts || null,
            cmd
        };
    }

    mostCommon(values) {
        const counts = {};
        values.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    }

    // An explicitly selected partition always wins; otherwise guess from the
    // given nodes, preferring the partitions users normally submit to.
    hintPartition(nodes, preferred = PREFERRED_GPU_PARTITIONS) {
        if (this.partitionFilter) return this.partitionFilter;

        const counts = {};
        nodes.forEach((node) => (node.partitions || []).forEach((p) => {
            counts[p] = (counts[p] || 0) + 1;
        }));

        const byFrequency = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        return preferred.find((p) => counts[p])
            || (byFrequency[0] && byFrequency[0][0])
            || null;
    }

    updateDrilldownPanel(matchedNodes, capabilityNodes = matchedNodes) {
        const panel = document.getElementById('drilldown-panel');

        if (!this.hasDrilldown()) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
            return;
        }

        panel.classList.remove('hidden');

        // The panel is rebuilt on every table update; keep keyboard focus on the
        // toggle if that is what the user was interacting with.
        const restoreToggleFocus = document.activeElement
            && document.activeElement.id === 'drilldown-available-only';

        const resource = this.drilldownResource();
        const isGpu = resource === 'gpu';
        const nodeCount = matchedNodes.length;
        const freeUnits = matchedNodes.reduce(
            (sum, node) => sum + (isGpu ? (node.gpu_free || 0) : (node.cpus_free || 0)), 0
        );
        const unit = isGpu ? 'GPU' : 'CPU';
        const reservedCount = matchedNodes.filter(
            (node) => (node.reservations || []).some(r => r.state === 'ACTIVE')
        ).length;

        const partitionInfo = this.partitionFilter
            ? (this.scopedPartitions || {})[this.partitionFilter]
            : null;

        // Exactly one card can be selected, so there is exactly one chip.
        const chipSpec = this.gpuTypeFilter
            ? { icon: 'fa-microchip', text: this.gpuLabel() }
            : { icon: 'fa-layer-group', text: this.partitionFilter };
        const filterChips = `
            <span class="drilldown-chip">
                <i class="fas ${chipSpec.icon}"></i> ${escapeHtml(chipSpec.text)}
                <button type="button" class="drilldown-chip-clear"
                        data-action="clear-drilldown"
                        aria-label="Clear the ${escapeHtml(chipSpec.text)} filter"
                        title="Clear this filter"><i class="fas fa-xmark"></i></button>
            </span>`;

        // Only meaningful when the partition itself was not the filter.
        const partitions = this.partitionFilter
            ? []
            : [...new Set(matchedNodes.flatMap((node) => node.partitions || []))].sort();

        const scopeNote = (!this.partitionFilter && this.currentPartitionScope !== 'all')
            ? ` in <strong>${escapeHtml(this.currentPartitionScope)}</strong>`
            : '';

        // Biggest free block first: whole-node jobs need those.
        const chips = [...matchedNodes]
            .sort((a, b) => {
                const av = isGpu ? (a.gpu_free || 0) : (a.cpus_free || 0);
                const bv = isGpu ? (b.gpu_free || 0) : (b.cpus_free || 0);
                return bv - av || a.name.localeCompare(b.name);
            })
            .map((node) => {
                const reserved = (node.reservations || []).some(r => r.state === 'ACTIVE');
                const free = isGpu ? (node.gpu_free || 0) : (node.cpus_free || 0);
                const gpuPart = node.has_gpu
                    ? `${node.gpu_free || 0} free of ${node.gpu_count} ${escapeHtml((node.gpu_type || '').toUpperCase())} GPUs, `
                    : '';
                return `
                    <button type="button" class="node-chip${reserved ? ' node-chip-reserved' : ''}"
                            data-node-name="${escapeHtml(node.name)}"
                            title="${escapeHtml(node.name)} — ${gpuPart}${node.cpus_free} free CPUs, ${Math.round((node.memory_free || 0) / 1024)} GB free memory${reserved ? ' (ACTIVE reservation)' : ''}">
                        <span class="node-chip-name">${escapeHtml(node.name)}</span>
                        <span class="node-chip-count">${free}&nbsp;${isGpu ? 'free' : 'CPUs'}</span>
                        ${reserved ? '<i class="fas fa-lock"></i>' : ''}
                    </button>`;
            }).join('');

        const srunHints = this.buildSrunHints(capabilityNodes);
        const canScope = this.partitionFilter && this.currentPartitionScope !== this.partitionFilter;
        const label = this.drilldownLabel();

        const hintRows = srunHints.map((hint) => `
            <div class="drilldown-hint">
                <span class="hint-tag" title="${escapeHtml(hint.detail)}">${escapeHtml(hint.tag)}</span>
                <code>${escapeHtml(hint.cmd)}</code>
                <span class="hint-detail">${escapeHtml(hint.detail)}</span>
                <button type="button" class="btn btn-ghost btn-copy" data-action="copy-hint"
                        data-copy="${escapeHtml(hint.cmd)}" aria-label="Copy command for ${escapeHtml(hint.tag)}">
                    <i class="fas fa-copy"></i> Copy
                </button>
            </div>`).join('');

        // Explain the contributed-node arrangement. Crucially, a lab partition
        // does not put the nodes out of reach: when the same nodes are also in a
        // shared partition, anyone may run there and simply risks preemption. The
        // "you cannot submit" wording is only correct when no shared route exists.
        // Deduplicated by partition, so several GPU models in one lab partition do
        // not repeat the same sentence.
        const ownerRoutes = [...new Map(
            srunHints.filter((hint) => hint.ownerOnly).map((hint) => [hint.partition, hint])
        ).entries()];
        const ownerPartitionNames = ownerRoutes.map(([name]) => name);

        // Shared routes are read from the nodes themselves, not from the rows on
        // screen. Pinning a lab partition shows only that one row, but the nodes
        // behind it are usually still in a shared partition — claiming otherwise
        // would tell non-members they have no way onto hardware they can use.
        const sharedPartitionNames = new Set(
            srunHints.filter((hint) => !hint.ownerOnly).map((hint) => hint.partition)
        );
        capabilityNodes
            .filter((node) => (node.partitions || []).some((p) => ownerPartitionNames.includes(p)))
            .forEach((node) => (node.partitions || []).forEach((p) => {
                if (!this.isOwnerOnlyPartition(p)) sharedPartitionNames.add(p);
            }));

        const sharedCandidates = [...sharedPartitionNames];
        const preferredSharedName = sharedCandidates.find((name) => this.isPreemptiblePartition(name))
            || sharedCandidates[0];
        const preferredShared = preferredSharedName
            ? { partition: preferredSharedName, preemptible: this.isPreemptiblePartition(preferredSharedName) }
            : null;

        const isPlural = ownerRoutes.length !== 1;
        // "-p <name>" rather than the bare partition name: the whole point of the
        // note is which flag each reader should actually type.
        const ownerFlags = ownerRoutes
            .map(([name]) => `<code>-p ${escapeHtml(name)}</code>`)
            .join(', ');
        // Name the group/account when Slurm gave us exactly one partition to talk
        // about; otherwise stay generic rather than build an unreadable list.
        let ownerMembers = `${isPlural ? 'their' : 'its'} members`;
        if (ownerRoutes.length === 1) {
            const only = ownerRoutes[0][1];
            if (only.allowGroups) {
                ownerMembers = `members of <strong>${formatNameList(only.allowGroups)}</strong>`;
            } else if (only.allowAccounts) {
                ownerMembers = `the <strong>${formatNameList(only.allowAccounts)}</strong> account`;
            }
        }

        let contributedNote = '';
        if (ownerRoutes.length && preferredShared) {
            contributedNote = `
            <div class="drilldown-hints-note">
                <i class="fas fa-circle-info"></i>
                <span>
                    ${ownerFlags} ${isPlural ? 'are lab-owned partitions' : 'is a lab-owned partition'} —
                    only ${ownerMembers} can submit there.
                    Everyone else reaches the same nodes with
                    <code>-p ${escapeHtml(preferredShared.partition)}</code>${preferredShared.preemptible
                        ? ', where a job runs until the owning lab needs the node and is then preempted'
                        : ''}.
                </span>
            </div>`;
        } else if (ownerRoutes.length) {
            contributedNote = `
            <div class="drilldown-hints-note">
                <i class="fas fa-circle-info"></i>
                <span>
                    ${ownerFlags} ${isPlural ? 'are lab-owned partitions' : 'is a lab-owned partition'} —
                    only ${ownerMembers} can submit there. These nodes are not in a shared
                    partition, so there is no general-access route to them.
                </span>
            </div>`;
        }

        const overflowNote = srunHints.overflow ? `
            <div class="drilldown-hints-note">
                <i class="fas fa-circle-info"></i>
                <span>${srunHints.overflow} further partition${srunHints.overflow === 1 ? '' : 's'} also
                reach${srunHints.overflow === 1 ? 'es' : ''} these nodes; see the Partitions column in the table.</span>
            </div>` : '';

        // A specific GPU type fans out over partitions; anything else fans out
        // over resources, so the heading differs.
        const fanningOutByPartition = Boolean(this.gpuTypeFilter)
            && this.gpuTypeFilter !== ALL_GPU_TYPES
            && srunHints.length > 1;

        const hintsHeading = srunHints.length === 1
            ? 'Example job'
            : (fanningOutByPartition
                ? `Example jobs — these GPUs are reachable through ${plural(srunHints.length, 'partition')}`
                : `Example jobs — this selection offers ${srunHints.length} different requests`);

        panel.innerHTML = `
            <div class="drilldown-head">
                <div class="drilldown-title">
                    ${filterChips}
                    <span class="drilldown-summary">
                        <strong>${freeUnits}</strong> free ${unit}${freeUnits === 1 ? '' : 's'} across
                        <strong>${nodeCount}</strong> node${nodeCount === 1 ? '' : 's'}${scopeNote}
                    </span>
                </div>
                <div class="drilldown-actions">
                    <label class="drilldown-toggle">
                        <input type="checkbox" id="drilldown-available-only" ${this.gpuAvailableOnly ? 'checked' : ''}>
                        ${isGpu ? 'Only nodes with free GPUs' : 'Only nodes with spare capacity'}
                    </label>
                    <button type="button" class="btn btn-clear" data-action="clear-drilldown"
                            title="Clear this filter and go back to the full overview">
                        <i class="fas fa-xmark"></i> Clear filter
                    </button>
                </div>
            </div>

            ${nodeCount === 0 ? `
                <div class="drilldown-empty">
                    <i class="fas fa-circle-info"></i>
                    ${this.gpuAvailableOnly
                        ? `Nothing free in ${escapeHtml(label)} right now. Uncheck the box above to see every matching node.`
                        : `No nodes match ${escapeHtml(label)} in the current partition scope.`}
                </div>` : `
                <div class="node-chip-list">${chips}</div>
                <div class="drilldown-footer">
                    ${partitions.length ? `<span class="drilldown-note"><i class="fas fa-layer-group"></i> Partitions: ${escapeHtml(partitions.join(', '))}</span>` : ''}
                    ${partitionInfo ? `<span class="drilldown-note"><i class="far fa-clock"></i> Time limit ${escapeHtml(partitionInfo.time_limit)}</span>` : ''}
                    ${partitionInfo ? `<span class="drilldown-note"><i class="fas fa-server"></i> ${partitionInfo.idle_nodes} of ${partitionInfo.total_nodes} nodes idle</span>` : ''}
                    ${reservedCount ? `<span class="drilldown-note drilldown-warn"><i class="fas fa-lock"></i> ${reservedCount} node${reservedCount === 1 ? '' : 's'} under an active reservation</span>` : ''}
                </div>
            `}

            ${/* Outside the branch above: the commands describe what the selection
                  can be asked for, so they stay useful even when nothing is free. */ ''}
            ${srunHints.length ? `
            <div class="drilldown-hints">
                <div class="drilldown-hints-label">
                    <i class="fas fa-terminal"></i>
                    ${hintsHeading}
                </div>
                ${hintRows}
                ${contributedNote}
                ${overflowNote}
            </div>` : ''}
            ${canScope ? `
            <div class="drilldown-extra">
                <button type="button" class="btn btn-ghost" data-action="scope-partition" data-partition="${escapeHtml(this.partitionFilter)}">
                    <i class="fas fa-crosshairs"></i> Scope dashboard to ${escapeHtml(this.partitionFilter)}
                </button>
            </div>` : ''}
        `;

        if (restoreToggleFocus) {
            const toggle = document.getElementById('drilldown-available-only');
            if (toggle) toggle.focus();
        }
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
