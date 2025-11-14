# System Status for Tufts Open OnDemand

A real-time web dashboard for monitoring SLURM cluster status, including GPU availability, partition information, node details, and job queue.

## Features

- **Real-time Monitoring**: Auto-refreshes every 30 seconds (configurable)
- **GPU Overview**: Visual cards showing GPU types, availability, and usage
- **Partition Summary**: Status of all partitions with node counts and limits
- **Node Details**: Sortable and filterable table of all cluster nodes
- **Job Queue**: Current jobs running and pending in the cluster
- **Cluster Statistics**: Quick overview of total resources and availability
- **Responsive Design**: Works on desktop and mobile devices

## Installation

This app is designed to run as a Passenger Rack app in Open OnDemand (OOD). No Gemfile or Bundler are required because OOD already ships with a Ruby runtime and Sinatra for Passenger apps.

### Requirements

- Open OnDemand environment (Passenger + per-user NGINX)
- SLURM client tools (sinfo, scontrol, squeue)
- Shell PATH for the Passenger process must be able to locate `sinfo`, `scontrol`, `squeue`

### Setup

1. Place this directory in your OOD apps area. Common options:

   - User dev space: `~/ondemand/dev/cluster-dashboard/` or `~/ondemand/prod/cluster-dashboard/`
   - System app (admin): `/var/www/ood/apps/sys/cluster-dashboard/`

2. Restart the app (or your PUN) so Passenger reloads it:

   ```bash
   cd /path/to/cluster-dashboard
   mkdir -p tmp && touch tmp/restart.txt
   ```

   Or use the “Restart App” button in the OOD UI.

3. Launch from the OOD dashboard. The app will be mounted under a sub-URL like `/pun/dev/cluster-dashboard`.

Notes:

- A Gemfile is not necessary. If you add one, OOD will try to run Bundler which may require outbound network access and additional configuration. This app is intentionally Gemfile‑free to work with OOD’s provided environment.

## File Structure

```
cluster-dashboard/
├── manifest.yml          # OOD app metadata
├── config.ru             # Rack configuration
├── app.rb                # Sinatra web application
├── lib/
│   └── slurm_parser.rb   # SLURM command parser module
├── views/
│   └── index.erb         # Main dashboard template
├── public/
│   ├── styles.css        # Dashboard styling
│   └── script.js         # Client-side JavaScript
└── README.md             # This file
```

## API Endpoints

The dashboard provides several API endpoints:

- `GET /` - Main dashboard page
- `GET /api/data` - Complete dashboard data (all information used by the UI)
- `GET /api/nodes` - Node information only
- `GET /api/gpu` - GPU summary only
- `GET /api/partitions` - Partition information only
- `GET /api/queue` - Job queue only
- `GET /health` - Health check endpoint

## Features in Detail

### GPU Overview

- Shows all GPU types in the cluster
- Displays total, available, in-use, and down GPUs
- Visual progress bar for usage percentage
- Color-coded cards for easy identification

### Partition Summary

- Lists all SLURM partitions
- Shows node counts by status (idle, mixed, allocated, down)
- Displays available CPUs and time limits
- Highlights default partition and GPU-enabled partitions

### Node Details Table

- Complete list of all cluster nodes
- Sortable by any column (click headers)
- Filterable by status or GPU availability
- Search functionality for quick node lookup
- Shows CPU, memory, GPU, and partition information

### Job Queue

- Current jobs in the system
- Job state, runtime, and resource usage
- User and partition information
- Reason for pending jobs

## Customization

### Change Auto-Refresh Interval

Edit `public/script.js`:

```javascript
this.refreshIntervalMs = 30000; // Change to desired milliseconds
```

### Modify Colors

Edit `public/styles.css` to change the CSS variables:

```css
:root {
  --primary: #3498db;
  --success: #2ecc71;
  --warning: #f39c12;
  --danger: #e74c3c;
  /* ... */
}
```

### Add More SLURM Commands

Edit `lib/slurm_parser.rb` to parse additional SLURM commands or add custom logic.

### Enable Browser Debug Logs

Append `?debug=1` to the app URL to print concise, copyable logs to the browser console:

```
https://<ood-host>/pun/dev/cluster-dashboard?debug=1
```

Shows fetched stats, partitions, GPU summary, first few nodes, and job counts.

## How It Works (at a glance)

1. Browser loads `/` → serves `views/index.erb` with CSS/JS.
2. Frontend calls `GET /api/data` every 30s.
3. Backend (`lib/slurm_parser.rb`) executes live SLURM commands:
   - `scontrol show node --oneliner` (nodes, CPUs, memory, GPUs, partitions, state)
   - `sinfo -o "%P %a %l %D %t"` (partition availability, time limits, counts)
   - `squeue -o "%i %j %u %t %M %D %C %P %R"` (job list)
4. Backend parses output and returns JSON; frontend renders cards/tables.

GPU “in‑use” is estimated for mixed/allocated nodes using CPU usage ratio; for exact GPU accounting you can extend parsing to include per-job GRES usage.

## Troubleshooting

### Dashboard shows "No data"

- Ensure SLURM commands are accessible from the web server
- Check that sinfo, scontrol, and squeue are in the PATH
- Verify permissions to execute SLURM commands

### See “App is missing Gemfile” / “Not a valid git repo”

- These warnings in the OOD dev panel are informational and safe to ignore for this app. It does not require a Gemfile.

### Auto-refresh not working

- Check browser console for JavaScript errors
- Ensure the `/api/data` endpoint is accessible
- Try disabling and re-enabling auto-refresh toggle

### Styling issues

- Clear browser cache
- Check that `public/styles.css` is loading correctly. The app uses `request.script_name` to reference assets under OOD’s sub‑URL; if you change templates, ensure those paths remain relative to the mount point.
- Verify Font Awesome CDN is accessible

## License

Created by Javier Laveaga. This app is provided as-is for use in Open OnDemand environments.

## Support

For issues or questions, consult your local Open OnDemand administrator.
