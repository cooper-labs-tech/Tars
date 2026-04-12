import React from 'react';
import { Cpu } from 'lucide-react';
import { PROVIDER_REGISTRY, type ProviderIconDef } from '@/lib/providers';

/** Render the correct icon for any provider icon definition */
function ProviderIconRenderer({ icon, className = 'w-3.5 h-3.5' }: { icon: ProviderIconDef; className?: string }) {
  if (icon.type === 'image') {
    return <img src={icon.src} alt="" className={`${className} object-contain`} />;
  }
  if (icon.type === 'svg-gemini') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={`${className} !text-black`}>
        <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
      </svg>
    );
  }
  if (icon.type === 'svg-openrouter') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={className}>
        <path d="M4 12h4l2-4 4 8 2-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon.type === 'svg-deepseek') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5v-2.09c-1.67-.44-3-1.7-3.5-3.41h2.09c.43 1.08 1.46 1.8 2.66 1.8 1.58 0 2.87-1.29 2.87-2.87S13.83 7.06 12.25 7.06c-1.2 0-2.23.72-2.66 1.8H7.5c.5-1.71 1.83-2.97 3.5-3.41V3.5h2v1.95c2.47.49 4.25 2.68 4.25 5.3 0 2.61-1.78 4.81-4.25 5.3v2.45h-2z" />
      </svg>
    );
  }
  if (icon.type === 'svg-moonshot') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2a9.94 9.94 0 0 0-6.38 2.31C8.07 3.47 11.18 4.64 13.5 7c2.37 2.37 3.53 5.49 2.69 7.93A9.94 9.94 0 0 0 22 12c0-5.52-4.48-10-10-10zM2 12c0 5.52 4.48 10 10 10a9.94 9.94 0 0 0 6.38-2.31c-2.45.84-5.56-.33-7.88-2.69C8.13 14.63 6.97 11.51 7.81 9.07A9.94 9.94 0 0 0 2 12z" />
      </svg>
    );
  }
  if (icon.type === 'svg-mimo') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M3 6h4v12H3V6zm7 0h4v12h-4V6zm7 0h4v12h-4V6z" opacity="0.8" />
        <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H5z" />
      </svg>
    );
  }
  if (icon.type === 'svg-qwen') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon.type === 'svg-zai') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M4 6h16v2H7.5l10 8H4v-2h12.5l-10-8H4V6z" />
      </svg>
    );
  }
  if (icon.type === 'svg-minimax') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M3 12l4-8h2l-3 6h4l-3 6h-2l4-8H5l4-8H7L3 12zm10 0l4-8h2l-3 6h4l-3 6h-2l4-8h-4l4-8h-2l-4 8z" />
      </svg>
    );
  }
  if (icon.type === 'svg-nvidia') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M9 4v9.3a4 4 0 0 0 4 4h2a4 4 0 0 0 4-4V4h-2v9.3a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V4H9zM3 4v16h2V4H3z" />
      </svg>
    );
  }
  if (icon.type === 'svg-nous') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
      </svg>
    );
  }
  if (icon.type === 'cpu') {
    return <Cpu className={className} />;
  }
  if (icon.type === 'text') {
    return <span className={`font-bold text-[9px] leading-none`}>{icon.content}</span>;
  }
  return null;
}

/** Build a lookup from provider id -> registry entry */
const PROVIDER_MAP = new Map(PROVIDER_REGISTRY.map((p) => [p.id, p]));

interface ProviderBadgeProps {
  provider: string;
  className?: string;
}

export default function ProviderBadge({ provider, className = '' }: ProviderBadgeProps) {
  const def = PROVIDER_MAP.get(provider as import('@/types/electron').AgentProvider);
  if (!def) return null;

  return (
    <span
      title={def.label}
      className={`relative inline-flex items-center justify-center w-6 h-6 bg-secondary ${className}`}
      style={{ borderRadius: 6 }}
    >
      <ProviderIconRenderer icon={def.icon} />
      <svg
        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 text-green-500"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle cx="8" cy="8" r="8" fill="currentColor" />
        <path d="M4.5 8.5L7 11L11.5 5.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// Re-export for backward compatibility
function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={`${className} !text-black`}>
      <path d="M12 0C12 6.627 6.627 12 0 12c6.627 0 12 5.373 12 12 0-6.627 5.373-12 12-12-6.627 0-12-5.373-12-12Z" />
    </svg>
  );
}

/**
 * Legacy PROVIDER_CONFIG for backward compatibility (used by TerminalDialog).
 * New code should use PROVIDER_REGISTRY from @/lib/providers instead.
 */
const PROVIDER_CONFIG: Record<string, {
  label: string;
  icon: string | React.FC<{ className?: string }>;
}> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => {
    let icon: string | React.FC<{ className?: string }>;
    if (p.icon.type === 'image') {
      icon = p.icon.src;
    } else {
      // Wrap SVG icon types into a component
      icon = ({ className }: { className?: string }) => (
        <ProviderIconRenderer icon={p.icon} className={className} />
      );
    }
    return [p.id, { label: p.label, icon }];
  }),
);

export { PROVIDER_CONFIG, GeminiLogo };
