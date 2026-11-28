import { useState } from 'react';
import { Box, Code2, Cpu, Globe, HardDrive, Layers, Monitor, Shield, Terminal, Zap } from 'lucide-react';

interface AppBadgeProps {
  /** PNG data URL of the program's real icon; falls back to a generic badge. */
  iconUrl?: string;
  name: string;
  size?: 'sm' | 'md';
}

export function AppBadge({ name, size = 'md', iconUrl }: AppBadgeProps) {
  const [broken, setBroken] = useState(false);
  const lower = name.toLowerCase();
  const dims = size === 'sm' ? 'w-6 h-6 rounded-md' : 'w-8 h-8 rounded-lg';
  const iconDims = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  let tintVar = 'var(--accent-tint)';
  let colorVar = 'var(--text-primary)';
  let Icon = Box;

  if (lower.includes('chrome') || lower.includes('edge') || lower.includes('browser') || lower.includes('code') || lower.includes('studio') || lower.includes('docker') || lower.includes('wsl') || lower.includes('vmmem')) {
    tintVar = 'color-mix(in srgb, var(--status-info) 18%, transparent)';
    colorVar = 'var(--status-info)';
    if (lower.includes('code') || lower.includes('studio')) Icon = Code2;
    else if (lower.includes('docker') || lower.includes('wsl') || lower.includes('vmmem')) Icon = Layers;
    else Icon = Globe;
  } else if (lower.includes('defender') || lower.includes('security') || lower.includes('msmpeng')) {
    tintVar = 'var(--status-safe-tint)';
    colorVar = 'var(--status-safe)';
    Icon = Shield;
  } else if (lower.includes('adobe') || lower.includes('figma')) {
    tintVar = 'color-mix(in srgb, var(--status-danger) 18%, transparent)';
    colorVar = 'var(--status-danger)';
    Icon = Zap;
  } else if (lower.includes('explorer') || lower.includes('dwm') || lower.includes('window')) {
    tintVar = 'color-mix(in srgb, var(--status-warn) 18%, transparent)';
    colorVar = 'var(--status-warn)';
    Icon = Monitor;
  } else if (lower.includes('node') || lower.includes('powershell') || lower.includes('terminal')) {
    tintVar = 'var(--accent-tint)';
    colorVar = 'var(--text-primary)';
    Icon = Terminal;
  } else if (lower.includes('steam') || lower.includes('powertoys') || lower.includes('raycast')) {
    tintVar = 'color-mix(in srgb, var(--status-info) 16%, transparent)';
    colorVar = 'var(--status-info)';
    Icon = Cpu;
  } else if (lower.includes('search') || lower.includes('mds')) {
    tintVar = 'color-mix(in srgb, var(--status-info) 14%, transparent)';
    colorVar = 'var(--status-info)';
    Icon = HardDrive;
  }

  if (iconUrl && !broken) {
    return (
      <img
        src={iconUrl}
        alt=""
        onError={() => setBroken(true)}
        className={`${dims} shrink-0 object-contain`}
      />
    );
  }

  return (
    <span
      className={`${dims} inline-flex items-center justify-center shrink-0 border border-[var(--glass-border)]`}
      style={{ backgroundColor: tintVar, color: colorVar }}
      aria-hidden="true"
    >
      <Icon className={iconDims} />
    </span>
  );
}
