import express from 'express';

import {
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  userSettingsDb,
} from '../modules/database/index.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import {
  readClaudePermissions,
  writeClaudePermissions,
  addClaudeAllowRule,
  readClaudeModel,
  CLAUDE_DEFAULT_MODEL_VALUE,
} from '../modules/providers/list/claude/claude-settings.provider.js';

const router = express.Router();

// ===============================
// Claude Permissions (single source: ~/.claude/settings.json)
// ===============================

// Read the effective allow/deny/ask rules from Claude's own settings file — the
// same file the terminal `claude` reads. This is the app's ONLY permission store.
router.get('/claude-permissions', async (req, res) => {
  try {
    const permissions = await readClaudePermissions();
    res.json({ success: true, permissions });
  } catch (error) {
    console.error('Error reading Claude permissions:', error);
    res.status(500).json({ error: 'Failed to read Claude permissions' });
  }
});

// Replace the allow/deny lists in ~/.claude/settings.json, preserving every other
// key (env, model, hooks, ...). The SDK enforces these on the next turn via settingSources.
router.put('/claude-permissions', async (req, res) => {
  try {
    const { allow, deny, ask } = req.body || {};
    const isStringArray = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!isStringArray(allow) || !isStringArray(deny) || !isStringArray(ask)) {
      return res.status(400).json({ error: 'allow/deny/ask must be arrays of strings' });
    }
    const permissions = await writeClaudePermissions({ allow, deny, ask });
    res.json({ success: true, permissions });
  } catch (error) {
    console.error('Error writing Claude permissions:', error);
    res.status(500).json({ error: 'Failed to write Claude permissions' });
  }
});

// Add a single entry to permissions.allow (behind an in-chat "grant permission" action).
router.post('/claude-permissions/allow', async (req, res) => {
  try {
    const { entry } = req.body || {};
    if (typeof entry !== 'string' || !entry.trim()) {
      return res.status(400).json({ error: 'entry must be a non-empty string' });
    }
    const permissions = await addClaudeAllowRule(entry.trim());
    res.json({ success: true, permissions });
  } catch (error) {
    console.error('Error adding Claude allow rule:', error);
    res.status(500).json({ error: 'Failed to add Claude allow rule' });
  }
});

// ===============================
// Claude Default Model (single source: ~/.claude/settings.json `model` key)
// ===============================

// Read the top-level `model` from Claude's own settings file — the same key the
// terminal `/model` writes. The value needs no translation: the model catalog is
// built from the SDK's own model list, so it speaks the same vocabulary this file
// stores. An absent key reports the 'default' sentinel.
//
// There is deliberately NO write endpoint. The default model is config owned by
// ~/.claude/settings.json (set by the terminal `/model`); the app only reads it.
// A per-chat model choice is session state, held in the client and carried out on
// each send as options.model — it must never rewrite the shared terminal default.
router.get('/claude-model', async (req, res) => {
  try {
    const model = await readClaudeModel();
    res.json({ success: true, model: model ?? CLAUDE_DEFAULT_MODEL_VALUE });
  } catch (error) {
    console.error('Error reading Claude model:', error);
    res.status(500).json({ error: 'Failed to read Claude model' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.removeSubscription(endpoint);

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

// ===============================
// UI Preferences (persisted per-user)
// ===============================

router.get('/ui-preferences', async (req, res) => {
  try {
    const settings = userSettingsDb.get(req.user.id);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error fetching UI preferences:', error);
    res.status(500).json({ error: 'Failed to fetch UI preferences' });
  }
});

router.put('/ui-preferences', async (req, res) => {
  try {
    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings must be an object of key-value pairs' });
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof key === 'string' && key.length <= 128) {
        sanitized[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }

    userSettingsDb.put(req.user.id, sanitized);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving UI preferences:', error);
    res.status(500).json({ error: 'Failed to save UI preferences' });
  }
});

export default router;
