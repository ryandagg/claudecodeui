import { ActivityIcon } from 'lucide-react';

import { formatTokenCount, resolveTokenUsageDisplay } from './tokenUsage';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

export default function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { usedTokens, contextLimit, percent } = resolveTokenUsageDisplay(usage);

  // Prefer "% of context window" when the server resolved the model's context
  // limit; otherwise fall back to the raw token count (non-Claude providers, an
  // unlisted model, or before the context-limit cache has loaded).
  const showPercent = percent !== null && contextLimit !== null;
  const title = showPercent
    ? `${usedTokens.toLocaleString()} of ${contextLimit.toLocaleString()} tokens (${percent}% of context window)`
    : `${usedTokens.toLocaleString()} tokens used`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={title}
      aria-label={showPercent ? 'Show token usage — percent of context window used' : 'Show token usage'}
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      {showPercent ? (
        <span className="font-medium text-foreground">{percent}%</span>
      ) : (
        <>
          <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
          <span className="hidden text-muted-foreground/70 sm:inline">tokens</span>
        </>
      )}
    </button>
  );
}
