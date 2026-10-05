"""tars-relay, dashboard half: the routes Tars calls, under /api/plugins/tars-relay/, behind the dashboard's
session token like every dashboard route.

  GET  /status            configured or not, sends in the last hour, replies waiting, the projects registered, the
                          store's id
  POST /send              {text, kind, ref?, project?}: sent as written, in plain text, to the user id in the
                          plugin's settings and to nobody else; returns the message id
  GET  /replies?after=N   the replies and @project messages Tars has not taken, oldest first, and the store's id:
                          a store made again numbers from 1, and Tars starts over when the id changes
  POST /ack               {through: N}: Tars has taken them up to N; they are deleted
  POST /projects          {projects: [name, ...]}: the projects "@name" may address, in place of the last ones

Tars cannot choose the recipient: the user id comes from Hermes's config on this server.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

log = logging.getLogger('tars-relay')


def _load_core():
    name = 'tars_relay_core'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parent.parent / 'relay_core.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules[name] = module
    return sys.modules[name]


core = _load_core()
router = APIRouter()
_stores = {}


def _store():
    from hermes_constants import get_hermes_home
    directory = str(Path(get_hermes_home()) / 'plugin-data' / core.PLUGIN_ID)
    if directory not in _stores:
        _stores[directory] = core.Store(directory)
    return _stores[directory]


def _settings():
    from hermes_cli.config import load_config_readonly
    return core.settings_from_config(load_config_readonly())


def _telegram():
    """The gateway's own bot token and API address, found the way Hermes finds them for its out-of-process sends."""
    from gateway.config import Platform, load_gateway_config
    platform = load_gateway_config().platforms.get(Platform.TELEGRAM)
    token = getattr(platform, 'token', None) or ''
    if not token:
        from agent.secret_scope import get_secret
        token = get_secret('TELEGRAM_BOT_TOKEN', '') or ''
    base_url = (getattr(platform, 'extra', None) or {}).get('base_url') or None
    return token, base_url


async def _send_plain(chat_id: str, text: str):
    """One message, as written: no parse mode, so nothing in it is read as Markdown or HTML, and no link preview."""
    from telegram import Bot, LinkPreviewOptions
    token, base_url = _telegram()
    if not token:
        raise RuntimeError('no Telegram bot token')
    bot = Bot(token=token, base_url=base_url) if base_url else Bot(token=token)
    async with bot:
        return await bot.send_message(chat_id=int(chat_id), text=text,
                                      link_preview_options=LinkPreviewOptions(is_disabled=True))


@router.get('/status')
def status():
    store = _store()
    return {'plugin': core.PLUGIN_ID, 'version': core.VERSION, 'configured': core.jeanbrasse_of(_settings()) is not None,
            'sends_last_hour': store.sends_last_hour(), 'waiting_replies': store.waiting_replies(),
            'projects': store.projects(), 'store_id': store.store_id}


@router.post('/send')
async def send(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = None
    try:
        outgoing = core.check_send(body)
    except core.Refused as refused:
        raise HTTPException(status_code=400, detail=str(refused))
    jeanbrasse = core.jeanbrasse_of(_settings())
    if jeanbrasse is None:
        raise HTTPException(status_code=503, detail='tars-relay has no user_id in its settings')
    store = await asyncio.to_thread(_store)
    # The place is taken before the message goes out, so that sends made at once cannot all pass the count.
    slot = await asyncio.to_thread(store.reserve, jeanbrasse)
    if slot is None:
        raise HTTPException(status_code=429, detail='%d sends in the last hour already' % core.SENDS_PER_HOUR)
    try:
        message = await _send_plain(jeanbrasse, outgoing['text'])
    except Exception as error:
        await asyncio.to_thread(store.release, slot)
        # The class only: an error from the HTTP client can carry the request's URL, and the bot token is in it.
        log.warning('tars-relay: Telegram did not take a message (%s)', type(error).__name__)
        raise HTTPException(status_code=502, detail='Telegram did not take the message (%s)' % type(error).__name__)
    await asyncio.to_thread(store.record_sent, chat_id=jeanbrasse, message_id=str(message.message_id), ref=outgoing['ref'],
                            kind=outgoing['kind'], project=outgoing['project'], text=outgoing['text'], slot=slot)
    return {'message_id': str(message.message_id)}


@router.get('/replies')
def replies(after: int = 0):
    store = _store()
    return {'replies': store.replies(after), 'store_id': store.store_id}


@router.post('/ack')
async def ack(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = None
    through = body.get('through') if isinstance(body, dict) else None
    if not isinstance(through, int) or isinstance(through, bool) or through < 0:
        raise HTTPException(status_code=400, detail='through must be the last seq taken, a whole number')
    return {'deleted': await asyncio.to_thread(_store().ack, through)}


@router.post('/projects')
async def projects(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = None
    try:
        names = core.check_projects(body)
    except core.Refused as refused:
        raise HTTPException(status_code=400, detail=str(refused))
    store = await asyncio.to_thread(_store)
    return {'projects': await asyncio.to_thread(store.set_projects, names)}
