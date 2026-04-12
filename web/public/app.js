// ── API helpers ──

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

const API = {
  status: () => api('/status'),
  specs: () => api('/specs'),
  specDetail: (id) => api(`/specs/${id}`),
  createSpec: (title, content) => api('/specs', { method: 'POST', body: { title, content } }),
  tasks: (params = '') => api(`/tasks${params}`),
  createTask: (data) => api('/tasks', { method: 'POST', body: data }),
  updateTask: (id, data) => api(`/tasks/${id}`, { method: 'PATCH', body: data }),
  agents: () => api('/agents'),
  decisions: (params = '') => api(`/decisions${params}`),
};

// ── Router ──

const routes = {
  '/': renderDashboard,
  '/tasks': renderTasks,
  '/specs': renderSpecs,
  '/agents': renderAgents,
  '/decisions': renderDecisions,
};

function navigate() {
  const hash = location.hash.slice(1) || '/';
  // Match spec detail
  const specMatch = hash.match(/^\/specs\/(.+)$/);

  // Update active nav
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.getAttribute('href') === `#${hash}` ||
      (specMatch && el.getAttribute('data-page') === 'specs'));
  });

  const content = document.getElementById('content');
  if (specMatch) {
    renderSpecDetail(content, specMatch[1]);
  } else if (routes[hash]) {
    routes[hash](content);
  } else {
    content.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><p>Page not found</p></div>';
  }
}

window.addEventListener('hashchange', navigate);
window.addEventListener('DOMContentLoaded', async () => {
  // Load project name
  const status = await API.status();
  document.getElementById('project-name').textContent = status.config?.name || 'Flightdeck';
  navigate();
});

// ── Helpers ──

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

function pill(state) {
  return `<span class="pill pill-${state}">${state.replace('_', ' ')}</span>`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Dashboard ──

async function renderDashboard(el) {
  const [status, tasks, agents, specs, decisions] = await Promise.all([
    API.status(), API.tasks(), API.agents(), API.specs(), API.decisions(),
  ]);

  const stats = status.taskStats || {};
  const runningTasks = tasks.filter(t => t.state === 'running');
  const recentDecisions = decisions.slice(-10).reverse();

  el.innerHTML = `
    <h2>Dashboard</h2>
    <div class="card-grid">
      <div class="stat-card">
        <div class="label">Project</div>
        <div class="value" style="font-size:18px">${status.config?.name || '—'}</div>
      </div>
      <div class="stat-card">
        <div class="label">Active Specs</div>
        <div class="value">${specs.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Tasks</div>
        <div class="value">${tasks.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Agents</div>
        <div class="value">${agents.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Total Cost</div>
        <div class="value">$${(status.totalCost || 0).toFixed(2)}</div>
      </div>
      <div class="stat-card">
        <div class="label">Done</div>
        <div class="value">${stats.done || 0}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <h3>Current Activity</h3>
      </div>
      ${runningTasks.length === 0
        ? '<p class="text-secondary text-sm">No tasks currently running.</p>'
        : `<table class="table-view"><thead><tr>
            <th>Task</th><th>Agent</th><th>Status</th><th>Updated</th>
          </tr></thead><tbody>
          ${runningTasks.map(t => `<tr>
            <td>${t.title}</td>
            <td class="mono text-sm">${t.assignedAgent || '—'}</td>
            <td>${pill(t.state)}</td>
            <td class="text-tertiary text-sm">${timeAgo(t.updatedAt)}</td>
          </tr>`).join('')}
          </tbody></table>`
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h3>Recent Decisions</h3>
        <a href="#/decisions" class="btn">View All</a>
      </div>
      ${recentDecisions.length === 0
        ? '<p class="text-secondary text-sm">No decisions yet.</p>'
        : recentDecisions.map(d => `<div class="timeline-item">
            <div class="title">${d.title} ${pill(d.status)}</div>
            <div class="reasoning">${d.reasoning || ''}</div>
            <div class="text-xs text-tertiary" style="margin-top:4px">${timeAgo(d.timestamp)} · confidence: ${(d.confidence * 100).toFixed(0)}%</div>
          </div>`).join('')
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h3>Quick Actions</h3>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="btn-new-spec">+ New Spec</button>
        <a href="#/tasks" class="btn">View Tasks</a>
        <a href="#/agents" class="btn">View Agents</a>
      </div>
    </div>
  `;

  document.getElementById('btn-new-spec')?.addEventListener('click', () => showCreateSpecModal());
}

// ── Tasks (Kanban) ──

let tasksView = 'kanban';

async function renderTasks(el) {
  const tasks = await API.tasks();
  const columns = ['pending', 'ready', 'running', 'in_review', 'done', 'failed', 'blocked', 'gated'];

  el.innerHTML = `
    <div class="section-header">
      <h2>Tasks</h2>
      <div style="display:flex;gap:8px">
        <div class="view-toggle">
          <button class="btn ${tasksView === 'kanban' ? 'active' : ''}" data-view="kanban">Board</button>
          <button class="btn ${tasksView === 'table' ? 'active' : ''}" data-view="table">Table</button>
        </div>
        <button class="btn btn-primary" id="btn-new-task">+ New Task</button>
      </div>
    </div>
    <div id="tasks-content"></div>
  `;

  el.querySelectorAll('.view-toggle .btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tasksView = btn.dataset.view;
      renderTasks(el);
    });
  });

  document.getElementById('btn-new-task')?.addEventListener('click', () => showCreateTaskModal());

  const container = document.getElementById('tasks-content');

  if (tasksView === 'kanban') {
    const kanban = document.createElement('div');
    kanban.className = 'kanban';

    for (const col of columns) {
      const colTasks = tasks.filter(t => t.state === col);
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.innerHTML = `
        <div class="kanban-column-header">
          <span>${col.replace('_', ' ')}</span>
          <span class="count">${colTasks.length}</span>
        </div>
      `;
      for (const t of colTasks) {
        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.innerHTML = `
          <div class="title">${t.title}</div>
          <div class="meta">
            <span class="mono">${t.id.slice(0, 8)}</span>
            ${t.assignedAgent ? `<span>👤 ${t.assignedAgent}</span>` : ''}
            ${t.role ? `<span>${t.role}</span>` : ''}
          </div>
        `;
        card.addEventListener('click', () => showTaskDetailModal(t));
        colEl.appendChild(card);
      }
      kanban.appendChild(colEl);
    }
    container.appendChild(kanban);
  } else {
    container.innerHTML = `
      <table class="table-view">
        <thead><tr>
          <th>ID</th><th>Title</th><th>Status</th><th>Role</th><th>Agent</th><th>Priority</th><th>Updated</th>
        </tr></thead>
        <tbody>
          ${tasks.map(t => `<tr style="cursor:pointer" data-task-id="${t.id}">
            <td class="mono text-sm">${t.id.slice(0, 8)}</td>
            <td>${t.title}</td>
            <td>${pill(t.state)}</td>
            <td class="text-sm">${t.role || '—'}</td>
            <td class="mono text-sm">${t.assignedAgent || '—'}</td>
            <td>${t.priority}</td>
            <td class="text-tertiary text-sm">${timeAgo(t.updatedAt)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    `;
    container.querySelectorAll('tr[data-task-id]').forEach(row => {
      row.addEventListener('click', () => {
        const task = tasks.find(t => t.id === row.dataset.taskId);
        if (task) showTaskDetailModal(task);
      });
    });
  }
}

// ── Specs ──

async function renderSpecs(el) {
  const specs = await API.specs();

  el.innerHTML = `
    <div class="section-header">
      <h2>Specs</h2>
      <button class="btn btn-primary" id="btn-new-spec-page">+ New Spec</button>
    </div>
    ${specs.length === 0
      ? '<div class="empty-state"><div class="icon">📋</div><p>No specs yet. Create one to get started.</p></div>'
      : specs.map(s => `<div class="card" style="cursor:pointer" data-spec-id="${s.id}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-weight:500">${s.title}</div>
              <div class="mono text-xs text-tertiary" style="margin-top:4px">${s.filename}</div>
            </div>
            <span class="mono text-sm text-tertiary">${s.id.slice(0, 8)}</span>
          </div>
        </div>`).join('')
    }
  `;

  document.getElementById('btn-new-spec-page')?.addEventListener('click', () => showCreateSpecModal());

  el.querySelectorAll('[data-spec-id]').forEach(card => {
    card.addEventListener('click', () => {
      location.hash = `/specs/${card.dataset.specId}`;
    });
  });
}

// ── Spec Detail ──

async function renderSpecDetail(el, specId) {
  const spec = await API.specDetail(specId);
  if (spec.error) {
    el.innerHTML = `<div class="empty-state"><div class="icon">❌</div><p>${spec.error}</p></div>`;
    return;
  }

  const tasks = spec.tasks || [];

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <a href="#/specs" class="text-secondary text-sm" style="text-decoration:none">← Back to Specs</a>
    </div>
    <h2>${spec.title}</h2>

    <div class="section">
      <h3>Content</h3>
      <div class="card spec-content"><pre style="white-space:pre-wrap">${escapeHtml(spec.content)}</pre></div>
    </div>

    <div class="section">
      <h3>Tasks (${tasks.length})</h3>
      ${tasks.length === 0
        ? '<p class="text-secondary text-sm">No tasks for this spec.</p>'
        : `<table class="table-view"><thead><tr>
            <th>Title</th><th>Status</th><th>Agent</th><th>Role</th>
          </tr></thead><tbody>
          ${tasks.map(t => `<tr>
            <td>${t.title}</td>
            <td>${pill(t.state)}</td>
            <td class="mono text-sm">${t.assignedAgent || '—'}</td>
            <td>${t.role || '—'}</td>
          </tr>`).join('')}
          </tbody></table>`
      }
    </div>
  `;
}

// ── Agents ──

async function renderAgents(el) {
  const agents = await API.agents();

  el.innerHTML = `
    <h2>Agents</h2>
    ${agents.length === 0
      ? '<div class="empty-state"><div class="icon">🤖</div><p>No agents registered.</p></div>'
      : `<table class="table-view"><thead><tr>
          <th>ID</th><th>Role</th><th>Runtime</th><th>Status</th><th>Session</th><th>Cost</th><th>Last Heartbeat</th>
        </tr></thead><tbody>
        ${agents.map(a => `<tr>
          <td class="mono text-sm">${a.id.slice(0, 12)}</td>
          <td>${a.role}</td>
          <td class="mono text-sm">${a.runtime}</td>
          <td>${pill(a.status)}</td>
          <td class="mono text-xs">${a.acpSessionId ? a.acpSessionId.slice(0, 12) : '—'}</td>
          <td>$${(a.costAccumulated || 0).toFixed(2)}</td>
          <td class="text-tertiary text-sm">${timeAgo(a.lastHeartbeat)}</td>
        </tr>`).join('')}
        </tbody></table>`
    }
  `;
}

// ── Decisions ──

async function renderDecisions(el) {
  const decisions = await API.decisions();

  el.innerHTML = `
    <h2>Decisions</h2>
    ${decisions.length === 0
      ? '<div class="empty-state"><div class="icon">⚖️</div><p>No decisions logged yet.</p></div>'
      : decisions.reverse().map(d => `<div class="timeline-item">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <div class="title">${d.title}</div>
            <div style="display:flex;gap:6px;align-items:center">
              ${pill(d.status)}
              <span class="pill pill-${d.type === 'architecture' ? 'gated' : 'ready'}">${d.type}</span>
            </div>
          </div>
          <div class="reasoning">${d.reasoning || ''}</div>
          ${d.alternatives?.length ? `<div class="text-xs text-secondary" style="margin-top:4px">Alternatives: ${d.alternatives.join(', ')}</div>` : ''}
          <div class="text-xs text-tertiary" style="margin-top:4px">
            Confidence: ${(d.confidence * 100).toFixed(0)}% · ${d.reversible ? 'Reversible' : 'Irreversible'} · ${timeAgo(d.timestamp)}
          </div>
        </div>`).join('')
    }
  `;
}

// ── Modals ──

function showModal(content) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">${content}</div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

function showCreateSpecModal() {
  const overlay = showModal(`
    <h3>Create Spec</h3>
    <div class="field">
      <label>Title</label>
      <input type="text" id="spec-title" placeholder="e.g. Add OAuth2 support">
    </div>
    <div class="field">
      <label>Content (Markdown)</label>
      <textarea id="spec-content" placeholder="Describe the requirements..."></textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-create">Create</button>
    </div>
  `);

  overlay.querySelector('#modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#modal-create').addEventListener('click', async () => {
    const title = overlay.querySelector('#spec-title').value.trim();
    const content = overlay.querySelector('#spec-content').value;
    if (!title) return;
    await API.createSpec(title, content);
    overlay.remove();
    location.hash = '/specs';
    navigate();
  });
}

function showCreateTaskModal() {
  const overlay = showModal(`
    <h3>Create Task</h3>
    <div class="field">
      <label>Title</label>
      <input type="text" id="task-title" placeholder="e.g. Implement login endpoint">
    </div>
    <div class="field">
      <label>Description</label>
      <textarea id="task-desc" placeholder="What needs to be done..."></textarea>
    </div>
    <div class="field">
      <label>Role</label>
      <select id="task-role" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px">
        <option value="worker">Worker</option>
        <option value="lead">Lead</option>
        <option value="planner">Planner</option>
        <option value="reviewer">Reviewer</option>
      </select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-create">Create</button>
    </div>
  `);

  overlay.querySelector('#modal-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#modal-create').addEventListener('click', async () => {
    const title = overlay.querySelector('#task-title').value.trim();
    const description = overlay.querySelector('#task-desc').value;
    const role = overlay.querySelector('#task-role').value;
    if (!title) return;
    await API.createTask({ title, description, role });
    overlay.remove();
    renderTasks(document.getElementById('content'));
  });
}

function showTaskDetailModal(task) {
  showModal(`
    <h3>${task.title}</h3>
    <div style="margin-bottom:16px">
      ${pill(task.state)}
      ${task.role ? `<span class="pill pill-ready">${task.role}</span>` : ''}
    </div>
    <div style="margin-bottom:12px">
      <div class="text-xs text-secondary" style="margin-bottom:2px">ID</div>
      <div class="mono text-sm">${task.id}</div>
    </div>
    ${task.description ? `<div style="margin-bottom:12px">
      <div class="text-xs text-secondary" style="margin-bottom:2px">Description</div>
      <div class="text-sm">${escapeHtml(task.description)}</div>
    </div>` : ''}
    <div style="margin-bottom:12px">
      <div class="text-xs text-secondary" style="margin-bottom:2px">Assigned Agent</div>
      <div class="mono text-sm">${task.assignedAgent || '—'}</div>
    </div>
    <div style="margin-bottom:12px">
      <div class="text-xs text-secondary" style="margin-bottom:2px">Priority</div>
      <div class="text-sm">${task.priority}</div>
    </div>
    ${task.dependsOn?.length ? `<div style="margin-bottom:12px">
      <div class="text-xs text-secondary" style="margin-bottom:2px">Depends On</div>
      <div class="mono text-sm">${task.dependsOn.join(', ')}</div>
    </div>` : ''}
    <div style="display:flex;gap:8px">
      <div><span class="text-xs text-tertiary">Created:</span> <span class="text-xs">${timeAgo(task.createdAt)}</span></div>
      <div><span class="text-xs text-tertiary">Updated:</span> <span class="text-xs">${timeAgo(task.updatedAt)}</span></div>
    </div>
  `);
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
