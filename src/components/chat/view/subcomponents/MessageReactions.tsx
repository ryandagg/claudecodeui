import { memo, useState } from 'react';
import { ThumbsUp, ThumbsDown, AlertTriangle } from 'lucide-react';
import { cn } from '../../../../lib/utils';

export type ReactionType = 'thumbsup' | 'thumbsdown' | 'wtf';

type ReactionInfo = {
  id: number;
  reaction: ReactionType;
};

type MessageReactionsProps = {
  existingReaction?: ReactionInfo | null;
  onReact: (reaction: ReactionType) => Promise<void>;
  onRemoveReaction: (id: number) => Promise<void>;
};

const REACTIONS: Array<{ type: ReactionType; icon: typeof ThumbsUp; label: string; activeColor: string }> = [
  { type: 'thumbsup', icon: ThumbsUp, label: 'Helpful', activeColor: 'text-green-500' },
  { type: 'thumbsdown', icon: ThumbsDown, label: 'Not helpful', activeColor: 'text-red-500' },
  { type: 'wtf', icon: AlertTriangle, label: 'WTF?', activeColor: 'text-amber-500' },
];

const MessageReactions = memo(({ existingReaction, onReact, onRemoveReaction }: MessageReactionsProps) => {
  const [loading, setLoading] = useState(false);

  const handleClick = async (type: ReactionType) => {
    if (loading) return;
    setLoading(true);
    try {
      if (existingReaction?.reaction === type) {
        await onRemoveReaction(existingReaction.id);
      } else {
        if (existingReaction) {
          await onRemoveReaction(existingReaction.id);
        }
        await onReact(type);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-0.5">
      {REACTIONS.map(({ type, icon: Icon, label, activeColor }) => {
        const isActive = existingReaction?.reaction === type;
        return (
          <button
            key={type}
            onClick={(e) => {
              e.stopPropagation();
              void handleClick(type);
            }}
            disabled={loading}
            title={label}
            className={cn(
              'rounded p-0.5 transition-colors hover:bg-gray-200 dark:hover:bg-gray-700',
              isActive ? activeColor : 'text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100',
              isActive && 'opacity-100',
              loading && 'pointer-events-none opacity-50',
            )}
          >
            <Icon className="h-3 w-3" />
          </button>
        );
      })}
    </span>
  );
});

export default MessageReactions;
