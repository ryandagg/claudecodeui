import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
import { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
import { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
import { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';

import { seedUser, withIsolatedDatabase } from './helpers.js';

// ---------------------------------------------------------------------------
// notificationPreferencesDb
// ---------------------------------------------------------------------------
test('getNotificationPreferences seeds normalized defaults on first read', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    const prefs = notificationPreferencesDb.getNotificationPreferences(userId);
    assert.deepEqual(prefs, {
      channels: { inApp: false, webPush: false, desktop: false, sound: true },
      events: { actionRequired: true, stop: true, error: true },
    });
  });
});

test('updateNotificationPreferences normalizes partial input and upserts', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    // Only a couple of fields provided; the rest must be normalized, not dropped.
    const stored = notificationPreferencesDb.updateNotificationPreferences(userId, {
      channels: { inApp: true, sound: false, slack: true },
      events: { error: false },
    });
    assert.equal(stored.channels.inApp, true);
    assert.equal(stored.channels.sound, false);
    // Unknown boolean channels are preserved as extra channels.
    assert.equal(stored.channels.slack, true);
    assert.equal(stored.events.error, false);
    assert.equal(stored.events.stop, true);

    // Re-reading returns the persisted normalized value (upsert, not duplicate).
    const reread = notificationPreferencesDb.getNotificationPreferences(userId);
    assert.deepEqual(reread, stored);
  });
});

test('updatePreferences normalizes a non-object payload to defaults', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    // The legacy alias write path normalizes any odd input before storing.
    notificationPreferencesDb.updatePreferences(userId, 'not-an-object');
    const prefs = notificationPreferencesDb.getPreferences(userId);
    assert.equal(prefs.channels.sound, true);
    assert.equal(prefs.events.actionRequired, true);
  });
});

test('getNotificationPreferences survives a corrupt stored row and returns defaults', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    // Write a genuinely un-parseable row to exercise the read-path JSON.parse catch.
    getConnection()
      .prepare('INSERT INTO user_notification_preferences (user_id, preferences_json) VALUES (?, ?)')
      .run(userId, '{ not valid json');

    const prefs = notificationPreferencesDb.getNotificationPreferences(userId);
    assert.deepEqual(prefs, {
      channels: { inApp: false, webPush: false, desktop: false, sound: true },
      events: { actionRequired: true, stop: true, error: true },
    });
  });
});

// ---------------------------------------------------------------------------
// notificationChannelEndpointsDb
// ---------------------------------------------------------------------------
test('upsertEndpoint inserts then updates the same (user, channel, endpoint) row', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    const first = notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: 'slack',
      endpointId: 'C123',
      label: 'General',
      metadata: { team: 'eng' },
    });
    assert.equal(first.label, 'General');
    assert.equal(first.enabled, 1);
    assert.deepEqual(notificationChannelEndpointsDb.parseMetadata(first.metadata_json), { team: 'eng' });

    // Same identity → update, not a second row.
    const updated = notificationChannelEndpointsDb.upsertEndpoint({
      userId,
      channel: 'slack',
      endpointId: 'C123',
      label: 'Renamed',
      enabled: false,
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.label, 'Renamed');
    assert.equal(updated.enabled, 0);
    assert.equal(notificationChannelEndpointsDb.getEndpoints(userId, 'slack').length, 1);
  });
});

test('upsertEndpoint requires non-empty channel and endpointId', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    assert.throws(() => notificationChannelEndpointsDb.upsertEndpoint({ userId, channel: '  ', endpointId: 'x' }), /channel is required/);
    assert.throws(() => notificationChannelEndpointsDb.upsertEndpoint({ userId, channel: 'slack', endpointId: '' }), /endpointId is required/);
  });
});

test('getEnabledEndpoints and setEndpointEnabled reflect the enabled flag', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    notificationChannelEndpointsDb.upsertEndpoint({ userId, channel: 'slack', endpointId: 'A' });
    notificationChannelEndpointsDb.upsertEndpoint({ userId, channel: 'slack', endpointId: 'B' });

    assert.equal(notificationChannelEndpointsDb.getEnabledEndpoints(userId, 'slack').length, 2);

    assert.equal(notificationChannelEndpointsDb.setEndpointEnabled(userId, 'slack', 'B', false), true);
    const enabled = notificationChannelEndpointsDb.getEnabledEndpoints(userId, 'slack');
    assert.deepEqual(enabled.map((e) => e.endpoint_id), ['A']);

    // A no-op update on an unknown endpoint returns false.
    assert.equal(notificationChannelEndpointsDb.setEndpointEnabled(userId, 'slack', 'ghost', true), false);
  });
});

test('removeEndpoint deletes a single endpoint and reports whether a row was removed', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    notificationChannelEndpointsDb.upsertEndpoint({ userId, channel: 'slack', endpointId: 'A' });

    assert.equal(notificationChannelEndpointsDb.removeEndpoint(userId, 'slack', 'A'), true);
    assert.equal(notificationChannelEndpointsDb.getEndpoint(userId, 'slack', 'A'), null);
    assert.equal(notificationChannelEndpointsDb.removeEndpoint(userId, 'slack', 'A'), false);
  });
});

test('parseMetadata returns {} for null and malformed JSON', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    assert.deepEqual(notificationChannelEndpointsDb.parseMetadata(null), {});
    assert.deepEqual(notificationChannelEndpointsDb.parseMetadata('not json'), {});
    assert.deepEqual(notificationChannelEndpointsDb.parseMetadata('{"a":1}'), { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// pushSubscriptionsDb
// ---------------------------------------------------------------------------
test('createPushSubscription upserts by endpoint and getPushSubscriptions lists them', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const userId = seedUser();
    pushSubscriptionsDb.createPushSubscription(userId, 'https://push/1', 'p256-a', 'auth-a');

    // Same endpoint again → update keys in place, not a duplicate row.
    pushSubscriptionsDb.createPushSubscription(userId, 'https://push/1', 'p256-b', 'auth-b');

    const subs = pushSubscriptionsDb.getPushSubscriptions(userId);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].keys_p256dh, 'p256-b');
  });
});

test('deletePushSubscription and deletePushSubscriptionsForUser remove the right rows', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    const alice = seedUser('alice');
    const bob = seedUser('bob');
    pushSubscriptionsDb.saveSubscription(alice, 'https://push/a1', 'k', 'a');
    pushSubscriptionsDb.saveSubscription(alice, 'https://push/a2', 'k', 'a');
    pushSubscriptionsDb.saveSubscription(bob, 'https://push/b1', 'k', 'a');

    pushSubscriptionsDb.removeSubscription('https://push/a1');
    assert.equal(pushSubscriptionsDb.getSubscriptions(alice).length, 1);

    pushSubscriptionsDb.removeAllForUser(alice);
    assert.equal(pushSubscriptionsDb.getSubscriptions(alice).length, 0);
    // Bob's subscription is untouched.
    assert.equal(pushSubscriptionsDb.getSubscriptions(bob).length, 1);
  });
});

// ---------------------------------------------------------------------------
// vapidKeysDb
// ---------------------------------------------------------------------------
test('vapidKeysDb returns null before any key, then the latest pair', async () => {
  await withIsolatedDatabase('notifications-db', () => {
    assert.equal(vapidKeysDb.getVapidKeys(), null);

    vapidKeysDb.createVapidKeys('pub-1', 'priv-1');
    assert.deepEqual(vapidKeysDb.getVapidKeys(), { publicKey: 'pub-1', privateKey: 'priv-1' });

    // updateVapidKeys replaces all rows, so the newest pair is returned.
    vapidKeysDb.updateVapidKeys('pub-2', 'priv-2');
    assert.deepEqual(vapidKeysDb.getVapidKeys(), { publicKey: 'pub-2', privateKey: 'priv-2' });

    vapidKeysDb.deleteVapidKeys();
    assert.equal(vapidKeysDb.getVapidKeys(), null);
  });
});
