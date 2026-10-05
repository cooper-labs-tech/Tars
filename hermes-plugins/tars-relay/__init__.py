"""tars-relay, gateway half.

An observer and two hooks.
- The observer, a python-telegram-bot handler in the plugin's own group (OBSERVER_GROUP), sees each Telegram update
  as it comes, before Hermes merges messages (its batching window, its grace window) or turns one into a correction
  of a running turn: both skip pre_gateway_dispatch (the Audit's recheck of #280). It keeps for Tars a message from
  JeanBrasse in his private chat that replies to a message Tars sent through the relay or starts with "@project". It only
  looks: it never stops an update, never changes one (Hermes's answers of 2026-10-01, the deciding test on 536802c).
- pre_gateway_dispatch spares Hermes's model a message the observer kept, when Hermes admits that very message alone.
  An event Hermes merged it into goes on to the model whole: JeanBrasse's other words in it are his to Hermes. On a Hermes
  without plugin handlers it keeps the message itself, as before the observer.
- pre_llm_call attaches to JeanBrasse's next turn there a read-only copy of what Tars sent him.
The rules are in relay_core.py; this file only reads Hermes's updates, events and session and answers its hooks.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import sys
from pathlib import Path

log = logging.getLogger('tars-relay')


def _load_core():
    # By path, under one name for both halves: a plugin directory is not on sys.path, and the dashboard half loads
    # the same file.
    name = 'tars_relay_core'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().with_name('relay_core.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules[name] = module
    return sys.modules[name]


core = _load_core()
_stores = {}
# The observer's own python-telegram-bot group. Never 0: one handler runs per group, and a catch-all there would
# swallow the core's messages. Never 99: Hermes's own catch-all observer (gateway_platform_event, and the counts its
# stall detector reads) is there, and Hermes puts a plugin's handler ahead of the core's in a group, which would
# silence it. 100 is a group Hermes does not use.
OBSERVER_GROUP = 100
# Whether the observer is wired on this gateway: pre_gateway_dispatch keeps messages itself only when it is not.
_observer = {'wired': False}


def _store():
    """The store of the active Hermes profile, in its plugin-data folder, where Hermes keeps a plugin's state."""
    from hermes_constants import get_hermes_home
    directory = str(Path(get_hermes_home()) / 'plugin-data' / core.PLUGIN_ID)
    if directory not in _stores:
        _stores[directory] = core.Store(directory)
    return _stores[directory]


def _settings():
    from hermes_cli.config import load_config_readonly
    return core.settings_from_config(load_config_readonly())


def _message_of(event) -> dict:
    source = getattr(event, 'source', None)
    platform = getattr(source, 'platform', None)
    return {
        'platform': getattr(platform, 'value', platform),
        'chat_type': getattr(source, 'chat_type', None),
        'chat_id': getattr(source, 'chat_id', None),
        'user_id': getattr(source, 'user_id', None),
        'message_id': getattr(event, 'message_id', None),
        'reply_to_message_id': getattr(event, 'reply_to_message_id', None),
        'text': getattr(event, 'text', None),
    }


def _keep(message) -> None:
    store = _store()
    kept = core.decide(message, _settings(), store)
    if kept is not None and store.keep(kept, message.get('text') or '') is not None:
        log.info('tars-relay: kept a %s for Tars (message %s)', kept['kind'], kept['message_id'])


def _observer_factory(native, adapter):
    """Wires the observer on Hermes's python-telegram-bot Application (ctx.register_platform_handler)."""
    from telegram import Update
    from telegram.ext import TypeHandler

    async def observe(update, context):
        try:
            message = core.message_of_update(update)
            if message is not None:
                await asyncio.to_thread(_keep, message)
        except Exception:
            # Never into python-telegram-bot: Hermes's handlers have already had the update, and go on as they would.
            log.exception('tars-relay: could not look at a Telegram update')

    native.add_handler(TypeHandler(Update, observe), group=OBSERVER_GROUP)
    _observer['wired'] = True


def on_gateway_dispatch(event=None, **_):
    try:
        message = _message_of(event)
        if _observer['wired']:
            # The observer kept it already, if it is Tars's: spare the model that message alone, never a merged event.
            if not _store().was_kept(message.get('chat_id'), message.get('message_id'), message.get('text')):
                return None
        else:
            store = _store()
            kept = core.decide(message, _settings(), store)
            if kept is None:
                return None
            store.keep(kept, message.get('text') or '')
    except Exception:
        # The message goes on to Hermes rather than nowhere: Hermes answers it, so JeanBrasse sees it did not reach Tars.
        log.exception('tars-relay: could not keep a message for Tars; it goes on to Hermes')
        return None
    return {'action': 'skip', 'reason': 'tars-relay: kept for Tars'}


def on_llm_call(**_):
    # Who this turn is with comes from the session the gateway binds for the turn, never from the hook's arguments:
    # a turn with no bound session (the CLI, cron, a webhook) gets no copy.
    try:
        from gateway.session_context import get_session_env
        turn = {
            'platform': get_session_env('HERMES_SESSION_PLATFORM', ''),
            'chat_type': get_session_env('HERMES_SESSION_CHAT_TYPE', ''),
            'chat_id': get_session_env('HERMES_SESSION_CHAT_ID', ''),
            'user_id': get_session_env('HERMES_SESSION_USER_ID', ''),
        }
        block = core.copy_for_turn(turn, _settings(), _store())
    except Exception:
        log.exception('tars-relay: no copy of Tars\'s messages for this turn')
        return None
    return {'context': block} if block else None


def register(ctx):
    if hasattr(ctx, 'register_platform_handler'):
        ctx.register_platform_handler('telegram', _observer_factory)
    else:
        log.warning('tars-relay: this Hermes has no plugin handlers; a message Hermes merges or takes as a correction '
                    'does not reach Tars')
    ctx.register_hook('pre_gateway_dispatch', on_gateway_dispatch)
    ctx.register_hook('pre_llm_call', on_llm_call)
