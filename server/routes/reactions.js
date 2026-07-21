import express from 'express';

import { reactionsDb } from '../modules/database/index.js';

const router = express.Router();

const VALID_REACTIONS = new Set(['thumbsup', 'thumbsdown', 'wtf']);

router.post('/', async (req, res) => {
  try {
    const { sessionId, messageIndex, messageRole, messageContent, reaction } = req.body || {};

    if (!sessionId || messageIndex == null || !reaction) {
      return res.status(400).json({ error: 'sessionId, messageIndex, and reaction are required' });
    }
    if (!VALID_REACTIONS.has(reaction)) {
      return res.status(400).json({ error: `Invalid reaction. Must be one of: ${[...VALID_REACTIONS].join(', ')}` });
    }

    const row = reactionsDb.add(
      sessionId,
      Number(messageIndex),
      messageRole || 'unknown',
      messageContent || null,
      reaction,
    );
    res.json({ success: true, reaction: row });
  } catch (error) {
    console.error('Error adding reaction:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid reaction id' });
    }
    const removed = reactionsDb.remove(id);
    res.json({ success: removed });
  } catch (error) {
    console.error('Error removing reaction:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

router.get('/session/:sessionId', async (req, res) => {
  try {
    const reactions = reactionsDb.getForSession(req.params.sessionId);
    res.json({ success: true, reactions });
  } catch (error) {
    console.error('Error fetching reactions:', error);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { reaction, limit, offset } = req.query;
    const parsedLimit = limit ? Number(limit) : 200;
    const parsedOffset = offset ? Number(offset) : 0;

    let reactions;
    if (reaction && VALID_REACTIONS.has(reaction)) {
      reactions = reactionsDb.getByReaction(reaction, parsedLimit, parsedOffset);
    } else {
      reactions = reactionsDb.getAll(parsedLimit, parsedOffset);
    }

    const counts = reactionsDb.countByReaction();
    res.json({ success: true, reactions, counts, total: reactionsDb.count() });
  } catch (error) {
    console.error('Error fetching reactions:', error);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;
