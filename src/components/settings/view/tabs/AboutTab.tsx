import { MessageSquare } from 'lucide-react';

export default function AboutTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <span className="text-base font-semibold text-foreground">Claude GUI</span>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Local bridge UI for Claude Code sessions
          </p>
        </div>
      </div>

      <div className="border-t border-border/50 pt-4">
        <p className="text-xs text-muted-foreground/60">
          Fork of CloudCLI UI · Licensed under AGPL-3.0
        </p>
      </div>
    </div>
  );
}
