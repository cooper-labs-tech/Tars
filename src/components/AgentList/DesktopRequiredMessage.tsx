'use client';

import { MonitorDown } from 'lucide-react';

export function DesktopRequiredMessage() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-none bg-bg-tertiary flex items-center justify-center mx-auto mb-6">
          <MonitorDown className="w-10 h-10 text-text-muted" />
        </div>
        <h2 className="text-2xl font-bold mb-3">Desktop App Required</h2>
        <p className="text-text-secondary mb-6">
          The Agent Control Center requires the desktop application to run terminal commands and manage Claude Code agents directly on your machine.
        </p>
        <div className="space-y-3">
          <div className="p-4 rounded-none bg-bg-tertiary border border-border-primary">
            <p className="text-sm font-medium mb-2">To run the desktop app:</p>
            <code className="block p-2 rounded bg-term-bg text-primary text-xs font-mono">
              npm run electron:dev
            </code>
          </div>
          <p className="text-xs text-text-muted">
            {/* Not electron:build: since signed releases it needs the maintainer's Developer ID (OPERATIONS.md,
                "Package unsigned"). The unsigned copy is Tars Sandbox, started beside your own Tars. */}
            Or package an unsigned copy, Tars Sandbox: <code className="text-text-muted">npm run electron:pack</code>, then <code className="text-text-muted">npm run sandbox</code>
          </p>
        </div>
      </div>
    </div>
  );
}
