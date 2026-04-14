/**
 * Service installation: launchd (macOS) and systemd (Linux) user services.
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { FD_HOME } from '../constants.js';

const PLIST_LABEL = 'ai.flightdeck.gateway';

function getLaunchdPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function getSystemdPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'flightdeck-gateway.service');
}

function getNodePath(): string {
  return process.execPath;
}

function getEntryPoint(): string {
  return new URL('../index.js', import.meta.url).pathname;
}

export function installService(): void {
  const os = platform();

  if (os === 'darwin') {
    installLaunchd();
  } else if (os === 'linux') {
    installSystemd();
  } else {
    console.error(`Service install not supported on ${os}. Use 'flightdeck gateway start' instead.`);
    process.exit(1);
  }
}

export function uninstallService(): void {
  const os = platform();

  if (os === 'darwin') {
    uninstallLaunchd();
  } else if (os === 'linux') {
    uninstallSystemd();
  } else {
    console.error(`Service uninstall not supported on ${os}.`);
    process.exit(1);
  }
}

function installLaunchd(): void {
  const plistPath = getLaunchdPath();
  const node = getNodePath();
  const entry = getEntryPoint();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(FD_HOME, 'gateway.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(FD_HOME, 'gateway.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.local', 'bin')}</string>
  </dict>
</dict>
</plist>`;

  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(plistPath, plist);

  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
  } catch {}
  execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });

  console.log(`Installed launchd service: ${plistPath}`);
  console.log('Gateway will start automatically on login.');
  console.log(`Logs: ${join(FD_HOME, 'gateway.log')}`);
}

function uninstallLaunchd(): void {
  const plistPath = getLaunchdPath();
  if (!existsSync(plistPath)) {
    console.log('No launchd service found.');
    return;
  }
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
  } catch {}
  unlinkSync(plistPath);
  console.log('Launchd service removed.');
}

function installSystemd(): void {
  const unitPath = getSystemdPath();
  const node = getNodePath();
  const entry = getEntryPoint();

  const unit = `[Unit]
Description=Flightdeck Gateway
After=network.target

[Service]
Type=simple
ExecStart=${node} ${entry} gateway run
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${join(homedir(), '.local', 'bin')}

[Install]
WantedBy=default.target
`;

  const dir = join(homedir(), '.config', 'systemd', 'user');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(unitPath, unit);

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable flightdeck-gateway.service', { stdio: 'inherit' });
    execSync('systemctl --user start flightdeck-gateway.service', { stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to enable/start service. You may need to run manually:');
    console.error('  systemctl --user daemon-reload');
    console.error('  systemctl --user enable --now flightdeck-gateway.service');
  }

  console.log(`Installed systemd user service: ${unitPath}`);
  console.log('Gateway will start automatically on login.');
  console.log('Manage with: systemctl --user {start|stop|restart|status} flightdeck-gateway');
}

function uninstallSystemd(): void {
  const unitPath = getSystemdPath();
  if (!existsSync(unitPath)) {
    console.log('No systemd service found.');
    return;
  }
  try {
    execSync('systemctl --user stop flightdeck-gateway.service', { stdio: 'pipe' });
    execSync('systemctl --user disable flightdeck-gateway.service', { stdio: 'pipe' });
  } catch {}
  unlinkSync(unitPath);
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  } catch {}
  console.log('Systemd service removed.');
}
