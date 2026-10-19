"""The relay on every gateway Hermes has, not Telegram only (2.0.4, the maintainer's decisions of 18/10: one switch in
Settings, Hermes, Relay, "for every gateway Hermes has").

Hermes 0.21.4 and later hand a plugin each platform's own client (ctx.register_platform_handler) and send to any of
them out of the gateway's process (tools/send_message_tool.py). The plugin keeps one user per platform, matches a
reply on the platform and in the chat where the relay wrote, and gives the model its copy there only.

How this can fail, written before the code:
12. The users go wrong:
   - the user of one platform is taken on another: Telegram's id writes on Discord, Discord's on Signal;
   - a platform with no user set up keeps a message, or gets a copy;
   - the older `user_id` stops being Telegram's, or `users.telegram` does not win over it;
   - something that is not an id is taken for one: empty or blank, a boolean, a list, a mapping, an id with a space
     or a control character, longer than 128 characters, zero, negative or not a number on Telegram; or a platform
     name that is not one lowercase word; or `users` that is not a mapping.
13. What is kept goes wrong across platforms:
   - a reply to a message the relay sent on one platform is matched on another with the same chat and message ids;
   - on a platform whose private chat is not named by the user's id (Discord, Slack: a channel of its own), the
     user's reply in their private chat is refused, or a group, or another sender in that chat, is taken;
   - Telegram's rule is lost: there, the private chat with the bot is the user's own id;
   - the same chat and message ids on two platforms are kept as one message, or the dispatch hook's check answers
     for the wrong platform;
   - a kept message does not say which platform it came from, so Tars cannot tell where it was answered.
14. The copy for Hermes's model goes to the wrong place: on another platform than the one the message was sent on,
   or on the right platform in another chat.
15. A send goes wrong: it names a gateway that is not one lowercase word; or the hour's 60 are shared between
   gateways, so that sends on one stop those on another, or are not counted on each.
16. Who the user is on each gateway, as the plugin proposes it before the switch sets it: a user in the settings is
   not the one shown; with none, the one `<PLATFORM>_ALLOWED_USERS` allows is not proposed, or one is proposed when
   it allows several, or none, or "*" (everyone).
17. A store of version 1 (Telegram only) goes wrong when version 2 opens it:
   - a row is lost, or lands under another platform than telegram;
   - a reply's number changes, or a new reply takes a number a reader has already passed;
   - the store's id changes (Tars would start its replies over);
   - opening it twice migrates it twice;
   - the way back loses what was Telegram's, keeps rows of other platforms that version 1 would take for
     Telegram's, or changes the replies' numbers;
   - a store made by version 2 refuses version 1's own writes and reads (a plugin put back to 1.0.0).
"""
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import relay_core  # noqa: E402

TG = '1159000001'
DC = '412093318855'
SIGNAL = '+33600000001'
OTHER = '2220000002'
DM = '9001'  # the Discord private channel between the bot and the user: not the user's id
NOW = 1_790_000_000.0
USERS = {'users': {'telegram': TG, 'discord': DC, 'signal': SIGNAL}}

# The store of tars-relay 1.0.0, as it created it: copied from that version, so that the migration is tested on what
# users have on their servers.
V1_SCHEMA = """
CREATE TABLE IF NOT EXISTS sent (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  at REAL NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  project TEXT NOT NULL,
  copy_text TEXT,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS sent_at ON sent (at);
CREATE TABLE IF NOT EXISTS replies (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at REAL NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  project TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reply_to_message_id TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_at ON replies (at);
CREATE TABLE IF NOT EXISTS kept (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  at REAL NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS kept_at ON kept (at);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  folded TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
"""


def message(**over):
    """A message from the user in their private Discord channel with the bot, as the plugin reads it off Hermes."""
    base = {'platform': 'discord', 'chat_type': 'dm', 'chat_id': DM, 'user_id': DC, 'message_id': '8001',
            'reply_to_message_id': None, 'text': 'Yes'}
    base.update(over)
    return base


def turn(**over):
    base = {'platform': 'discord', 'chat_type': 'dm', 'chat_id': DM, 'user_id': DC}
    base.update(over)
    return base


def kept(**over):
    base = {'platform': 'discord', 'kind': 'reply', 'ref': 'question:q-2', 'project': 'tars', 'text': 'Yes',
            'user_id': DC, 'chat_id': DM, 'message_id': '8001', 'reply_to_message_id': '601'}
    base.update(over)
    return base


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='tars-relay-gw-')
        self.store = self.store_at(NOW)
        self.store.record_sent(platform='discord', chat_id=DM, message_id='601', ref='question:q-2', kind='question',
                               project='tars', text='Question from Tars-QA: may I run the gate again?')
        self.store.record_sent(platform='telegram', chat_id=TG, message_id='601', ref='report:r-9', kind='report',
                               project='tars', text='Report from Tars-Backend: the build is green.')
        self.store.set_projects(['tars'])

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def store_at(self, now):
        return relay_core.Store(self.dir, now=lambda: now)


class TheUsers(Base):
    def test_12_each_platform_has_its_own_user_and_no_other(self):
        for case in [message(user_id=TG, reply_to_message_id='601'),
                     message(platform='signal', chat_id=DC, user_id=DC, reply_to_message_id='601'),
                     message(platform='whatsapp', chat_id='33611', user_id='33611', reply_to_message_id='601'),
                     message(platform='whatsapp', text='@tars go')]:
            with self.subTest(case=case):
                self.assertIsNone(relay_core.decide(case, USERS, self.store))
        self.assertIsNone(relay_core.copy_for_turn(turn(platform='whatsapp', chat_id='33611', user_id='33611'), USERS,
                                                   self.store))

    def test_12_the_older_user_id_is_telegram_s_and_users_telegram_wins_over_it(self):
        self.assertEqual(relay_core.users_of({'user_id': TG}), {'telegram': TG})
        self.assertEqual(relay_core.users_of({'user_id': TG, 'users': {'telegram': '777'}}), {'telegram': '777'})
        self.assertEqual(relay_core.users_of({'user_id': TG, 'users': {'discord': DC}}), {'telegram': TG, 'discord': DC})
        self.assertEqual(relay_core.user_of({'users': {'telegram': TG}}), TG)
        self.assertEqual(relay_core.users_of({'users': {'discord': 412093318855}}), {'discord': DC}, 'YAML gives a number')

    def test_12_what_is_not_an_id_or_not_a_platform_name_is_nobody(self):
        for bad in ['', '   ', True, False, None, [], {}, 'a b', 'x\x00y', 'x\ny', 'a' * 129]:
            with self.subTest(bad=bad):
                self.assertEqual(relay_core.users_of({'users': {'discord': bad}}), {})
        for bad in [0, -5, '12x', '+33600000001']:
            with self.subTest(telegram=bad):
                self.assertEqual(relay_core.users_of({'users': {'telegram': bad}}), {})
        for name in ['Discord', 'dis cord', '', 'a' * 40, 1, 'discord\n']:
            with self.subTest(name=name):
                self.assertEqual(relay_core.users_of({'users': {name: DC}}), {})
        for users in [['discord'], 'discord', 5]:
            with self.subTest(users=users):
                self.assertEqual(relay_core.users_of({'users': users}), {})


class WhatIsKeptOnEachPlatform(Base):
    def test_13_a_reply_is_matched_on_the_platform_and_in_the_chat_where_the_relay_wrote(self):
        on_discord = relay_core.decide(message(reply_to_message_id='601', text='Yes, go'), USERS, self.store)
        self.assertEqual(on_discord, {'platform': 'discord', 'kind': 'reply', 'ref': 'question:q-2', 'project': 'tars',
                                      'text': 'Yes, go', 'user_id': DC, 'chat_id': DM, 'message_id': '8001',
                                      'reply_to_message_id': '601'})

        on_telegram = relay_core.decide(message(platform='telegram', chat_id=TG, user_id=TG, reply_to_message_id='601'),
                                        USERS, self.store)
        self.assertEqual((on_telegram['platform'], on_telegram['ref']), ('telegram', 'report:r-9'))

        # Sent on Telegram in a chat whose id is the Discord channel's: never Tars's message on Discord.
        self.store.record_sent(platform='telegram', chat_id=DM, message_id='777', ref='report:r-1', kind='report',
                               project='tars')
        self.assertIsNone(relay_core.decide(message(reply_to_message_id='777'), USERS, self.store))

    def test_13_a_private_channel_of_its_own_is_the_users_but_a_group_or_another_sender_is_not(self):
        self.assertIsNotNone(relay_core.decide(message(text='@tars go'), USERS, self.store))
        for case in [message(chat_type='group', reply_to_message_id='601'),
                     message(chat_type='channel', text='@tars go'),
                     message(user_id=OTHER, reply_to_message_id='601'),
                     message(chat_type=None, reply_to_message_id='601')]:
            with self.subTest(case=case):
                self.assertIsNone(relay_core.decide(case, USERS, self.store))

    def test_13_on_telegram_the_private_chat_is_still_the_users_own_id(self):
        self.assertIsNone(relay_core.decide(message(platform='telegram', chat_id=OTHER, user_id=TG,
                                                    reply_to_message_id='601'), USERS, self.store))

    def test_13_the_same_ids_on_two_platforms_are_two_messages(self):
        first = self.store.keep(kept(), 'Yes')
        second = self.store.keep(kept(platform='signal', user_id=SIGNAL), 'Yes')
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIsNone(self.store.keep(kept(), 'Yes'), 'the same message on the same platform, once')

        self.assertTrue(self.store.was_kept(DM, '8001', 'Yes', platform='discord'))
        self.assertFalse(self.store.was_kept(DM, '8001', 'Yes', platform='matrix'))
        self.assertFalse(self.store.was_kept(DM, '8001', 'Yes'), 'Telegram unless told')

    def test_13_a_kept_message_says_its_platform(self):
        self.store.keep(kept(), 'Yes')
        self.store.keep(kept(platform='telegram', chat_id=TG, user_id=TG, message_id='7002'), 'Yes')

        self.assertEqual([(r['platform'], r['chat_id']) for r in self.store.replies(0)], [('discord', DM), ('telegram', TG)])


class TheModelsCopyOnEachPlatform(Base):
    def test_14_the_copy_is_given_where_the_message_was_sent_and_nowhere_else(self):
        self.assertIsNone(relay_core.copy_for_turn(turn(chat_id='9002'), USERS, self.store), 'another channel')

        on_telegram = relay_core.copy_for_turn(turn(platform='telegram', chat_id=TG, user_id=TG), USERS, self.store)
        self.assertIn('Report from Tars-Backend', on_telegram)
        self.assertNotIn('Question from Tars-QA', on_telegram)

        on_discord = relay_core.copy_for_turn(turn(), USERS, self.store)
        self.assertIn('Question from Tars-QA', on_discord)
        self.assertNotIn('Report from Tars-Backend', on_discord)
        self.assertIsNone(relay_core.copy_for_turn(turn(), USERS, self.store), 'once')


class WhatMayBeSentOnEachGateway(Base):
    def test_15_a_send_names_one_gateway_or_none(self):
        self.assertEqual(relay_core.check_send({'text': 'x', 'kind': 'report', 'gateway': 'discord'})['gateway'],
                         'discord')
        self.assertEqual(relay_core.check_send({'text': 'x', 'kind': 'report'})['gateway'], '')
        for bad in ['Discord', 'dis cord', 'a' * 40, 5, None, 'telegram\n', ['discord']]:
            with self.subTest(gateway=bad):
                with self.assertRaises(relay_core.Refused):
                    relay_core.check_send({'text': 'x', 'kind': 'report', 'gateway': bad})

    def test_15_each_gateway_has_its_own_sixty_an_hour(self):
        taken = 0
        for _ in range(100):
            if self.store.reserve(TG, platform='telegram') is None:
                break
            taken += 1
        self.assertEqual(taken, relay_core.SENDS_PER_HOUR - 1, 'one already sent on Telegram this hour')
        self.assertIsNotNone(self.store.reserve(DM, platform='discord'), "Telegram's 60 do not stop Discord")
        self.assertEqual(self.store.sends_last_hour(platform='telegram'), relay_core.SENDS_PER_HOUR)
        self.assertEqual(self.store.sends_last_hour(platform='discord'), 2)


class WhoTheUserIsOnEachGateway(unittest.TestCase):
    def test_16_the_settings_first_then_the_one_user_hermes_allows(self):
        environ = {'TELEGRAM_ALLOWED_USERS': '5550001', 'DISCORD_ALLOWED_USERS': ' 412093318855 ',
                   'SIGNAL_ALLOWED_USERS': '+33600000001,+33600000002', 'SLACK_ALLOWED_USERS': '*',
                   'MATRIX_ALLOWED_USERS': ''}
        seen = relay_core.gateway_users(['telegram', 'discord', 'signal', 'slack', 'matrix', 'whatsapp'],
                                        {'users': {'telegram': TG}}, environ)

        self.assertEqual(seen, [
            {'gateway': 'telegram', 'user': TG, 'from': 'settings'},
            {'gateway': 'discord', 'user': DC, 'from': 'DISCORD_ALLOWED_USERS'},
            {'gateway': 'signal', 'user': None, 'from': 'SIGNAL_ALLOWED_USERS', 'why': 'several users allowed'},
            {'gateway': 'slack', 'user': None, 'from': 'SLACK_ALLOWED_USERS', 'why': 'everyone allowed'},
            {'gateway': 'matrix', 'user': None, 'from': None, 'why': 'no user allowed'},
            {'gateway': 'whatsapp', 'user': None, 'from': None, 'why': 'no user allowed'},
        ])


class TheStoreOfVersionOne(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='tars-relay-v1-')
        self.path = os.path.join(self.dir, 'relay.db')
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            db.executescript(V1_SCHEMA)
            db.execute("INSERT INTO meta (key, value) VALUES ('store_id', 'store-of-v1')")
            db.execute("INSERT INTO sent VALUES (?, '501', ?, 'question', 'question:q-1', 'tars', 'Question?')", (TG, NOW))
            for seq in (1, 2, 3):
                db.execute("INSERT INTO replies (at, kind, ref, project, chat_id, user_id, message_id, "
                           "reply_to_message_id, text) VALUES (?, 'reply', 'question:q-1', 'tars', ?, ?, ?, '501', ?)",
                           (NOW, TG, TG, str(7000 + seq), 'answer %d' % seq))
            db.execute('DELETE FROM replies WHERE seq <= 2')  # Tars took the first two
            db.execute("INSERT INTO kept VALUES (?, '7003', ?, ?)", (TG, NOW, relay_core._fingerprint('answer 3')))
            db.execute("INSERT INTO projects VALUES ('tars', 'tars')")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def open(self):
        return relay_core.Store(self.dir, now=lambda: NOW)

    def test_17_every_row_is_kept_as_telegram_s_and_the_numbers_go_on(self):
        store = self.open()

        self.assertEqual(store.store_id, 'store-of-v1')
        self.assertEqual(store.sent(TG, '501', platform='telegram')['ref'], 'question:q-1')
        self.assertIsNone(store.sent(TG, '501', platform='discord'))
        self.assertEqual([(r['seq'], r['platform'], r['text']) for r in store.replies(0)], [(3, 'telegram', 'answer 3')])
        self.assertTrue(store.was_kept(TG, '7003', 'answer 3', platform='telegram'))
        self.assertEqual(store.projects(), ['tars'])
        self.assertEqual(store.keep(kept(platform='telegram', chat_id=TG, user_id=TG, message_id='7004'), 'Yes'), 4)
        self.assertEqual(store.take_copies(TG, platform='telegram')[0]['text'], 'Question?')

    def test_17_opened_twice_it_is_migrated_once(self):
        self.open()
        store = self.open()

        self.assertEqual([r['seq'] for r in store.replies(0)], [3])
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], relay_core.SCHEMA_VERSION)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sent').fetchone()[0], 1)

    def test_17_the_way_back_keeps_telegram_s_rows_and_their_numbers_and_drops_the_rest(self):
        store = self.open()
        store.record_sent(platform='discord', chat_id=DM, message_id='601', ref='question:q-2', kind='question',
                          project='tars')
        store.keep(kept(), 'Yes')

        relay_core.migrate_down(self.dir)

        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 0)
            for table in ('sent', 'replies', 'kept'):
                columns = [row[1] for row in db.execute('PRAGMA table_info(%s)' % table)]
                self.assertNotIn('platform', columns, table)
            self.assertEqual(db.execute('SELECT chat_id, message_id, ref FROM sent').fetchall(), [(TG, '501', 'question:q-1')])
            self.assertEqual(db.execute('SELECT seq, chat_id FROM replies ORDER BY seq').fetchall(), [(3, TG)])
            self.assertEqual(db.execute('SELECT chat_id, message_id FROM kept').fetchall(), [(TG, '7003')])
            db.execute("INSERT INTO replies (at, kind, ref, project, chat_id, user_id, message_id, reply_to_message_id, "
                       "text) VALUES (?, 'reply', '', 'tars', ?, ?, '7009', '', 'late')", (NOW, TG, TG))
            self.assertEqual(db.execute('SELECT MAX(seq) FROM replies').fetchone()[0], 5, 'no number given twice')

    def test_17_a_store_of_version_two_takes_version_one_s_own_writes_and_reads(self):
        self.open()
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            db.execute("INSERT INTO sent (chat_id, message_id, at, kind, ref, project, copy_text) "
                       "VALUES (?, '502', ?, 'report', 'report:r-2', 'tars', NULL)", (TG, NOW))
            row = db.execute('SELECT chat_id, message_id, at, kind, ref, project FROM sent '
                             'WHERE chat_id = ? AND message_id = ? AND at >= ?', (TG, '502', NOW - 10)).fetchone()
            self.assertEqual(row[4], 'report:r-2')
            db.execute("INSERT OR IGNORE INTO kept (chat_id, message_id, at, fingerprint) VALUES (?, '7010', ?, 'f')",
                       (TG, NOW))
            db.execute("INSERT INTO replies (at, kind, ref, project, chat_id, user_id, message_id, reply_to_message_id, "
                       "text) VALUES (?, 'reply', '', 'tars', ?, ?, '7010', '', 'from 1.0.0')", (NOW, TG, TG))
        self.assertEqual(self.open().sent(TG, '502', platform='telegram')['ref'], 'report:r-2')
        self.assertEqual(self.open().replies(0)[-1]['platform'], 'telegram')


if __name__ == '__main__':
    unittest.main()
