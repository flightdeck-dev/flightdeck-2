"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatPanel = void 0;
const vscode = __importStar(require("vscode"));
class ChatPanel {
    static currentPanel;
    panel;
    client;
    disposables = [];
    constructor(panel, client) {
        this.panel = panel;
        this.client = client;
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === "send") {
                await this.handleSend(msg.content);
            }
            else if (msg.type === "load") {
                await this.loadHistory();
            }
        }, null, this.disposables);
    }
    static createOrShow(client) {
        const column = vscode.ViewColumn.Beside;
        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel("flightdeckChat", "Flightdeck Chat", column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        ChatPanel.currentPanel = new ChatPanel(panel, client);
    }
    async loadHistory() {
        try {
            const messages = await this.client.getMessages({ limit: 50 });
            this.panel.webview.postMessage({ type: "history", messages });
        }
        catch (err) {
            this.panel.webview.postMessage({
                type: "error",
                text: err instanceof Error ? err.message : "Failed to load messages",
            });
        }
    }
    async handleSend(content) {
        try {
            const result = await this.client.sendMessage(content);
            this.panel.webview.postMessage({ type: "response", result });
        }
        catch (err) {
            this.panel.webview.postMessage({
                type: "error",
                text: err instanceof Error ? err.message : "Failed to send message",
            });
        }
    }
    dispose() {
        ChatPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
    getHtml() {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 8px;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 8px;
  }
  .msg {
    margin-bottom: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  .msg.user {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
  }
  .msg.lead {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-left: 3px solid var(--vscode-textLink-foreground);
  }
  .msg.agent {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-left: 3px solid var(--vscode-charts-orange);
  }
  .msg .author {
    font-weight: bold;
    margin-bottom: 4px;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .msg .time {
    font-size: 0.75em;
    opacity: 0.5;
    float: right;
  }
  .msg code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
  }
  .msg pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 4px 0;
  }
  .error {
    color: var(--vscode-errorForeground);
    padding: 4px 8px;
    font-size: 0.85em;
  }
  #input-area {
    display: flex;
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border);
  }
  #input {
    flex: 1;
    padding: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    min-height: 36px;
    max-height: 120px;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  button {
    padding: 8px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .loading { opacity: 0.6; font-style: italic; }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" placeholder="Message Lead..." rows="1"></textarea>
    <button id="send">Send</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function addMessage(msg) {
    const div = document.createElement('div');
    const cls = msg.authorType || 'user';
    div.className = 'msg ' + cls;
    const author = msg.authorType === 'lead' ? '🎯 Lead' : msg.authorType === 'agent' ? '🤖 ' + msg.authorId : '👤 You';
    div.innerHTML = '<span class="time">' + formatTime(msg.createdAt) + '</span><div class="author">' + author + '</div>' + escapeHtml(msg.content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showLoading() {
    const div = document.createElement('div');
    div.className = 'msg lead loading';
    div.id = 'loading';
    div.textContent = 'Lead is thinking...';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideLoading() {
    const el = document.getElementById('loading');
    if (el) el.remove();
  }

  async function send() {
    const content = inputEl.value.trim();
    if (!content) return;
    inputEl.value = '';
    addMessage({ authorType: 'user', content, createdAt: new Date().toISOString() });
    sendBtn.disabled = true;
    showLoading();
    vscode.postMessage({ type: 'send', content });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'history') {
      messagesEl.innerHTML = '';
      for (const m of msg.messages) addMessage(m);
    } else if (msg.type === 'response') {
      hideLoading();
      sendBtn.disabled = false;
      if (msg.result?.response) {
        const r = msg.result.response;
        if (typeof r === 'string') {
          addMessage({ authorType: 'lead', content: r, createdAt: new Date().toISOString() });
        } else {
          addMessage(r);
        }
      }
    } else if (msg.type === 'error') {
      hideLoading();
      sendBtn.disabled = false;
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = '⚠ ' + msg.text;
      messagesEl.appendChild(div);
    }
  });

  // Load history on init
  vscode.postMessage({ type: 'load' });
</script>
</body>
</html>`;
    }
}
exports.ChatPanel = ChatPanel;
//# sourceMappingURL=chatPanel.js.map