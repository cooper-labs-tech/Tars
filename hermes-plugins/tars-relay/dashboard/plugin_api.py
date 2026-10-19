"""tars-relay, dashboard half: the routes Tars calls, under /api/plugins/tars-relay/, behind the dashboard's
session token like every dashboard route.

  GET  /status            configured or not, sends in the last hour, replies waiting, the projects registered, the
                          store's id, and each gateway Hermes has set up: who the user is there and whether the
                          relay reaches it
  POST /send              {text, kind, ref?, project?, gateway?}: sent as written, in plain text, to the user's
                          private chat on each gateway the settings name them on (on `gateway` alone when given),
                          and to nobody else; returns the message id on each, and why each one that failed did
  GET  /replies?after=N   the replies and @project messages Tars has not taken, oldest first, and the store's id:
                          a store made again numbers from 1, and Tars starts over when the id changes
  POST /ack               {through: N}: Tars has taken them up to N; they are deleted
  POST /projects          {projects: [name, ...]}: the projects "@name" may address, in place of the last ones

Tars cannot choose the recipient: the user's id on each gateway comes from Hermes's config on this server.
"""
from __future__ import annotations

import asyncio
import importlib.util
import logging
import os
import sys
import uuid
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


# The gateways whose private chat with the user the relay knows how to open: Hermes sends there out of the gateway's
# process (tools/send_message_tool.py). Telegram's chat is the user's id; Discord and Slack open one of their own.
REACHED = ('telegram', 'discord', 'slack', 'signal', 'whatsapp')


def _gateways():
    """The platforms Hermes has set up on this server, by name, and their configuration."""
    from gateway.config import load_gateway_config
    platforms = load_gateway_config().platforms
    return {getattr(kind, 'value', str(kind)): config for kind, config in platforms.items()
            if getattr(config, 'enabled', False)}


def _token(config, variable: str) -> str:
    token = (getattr(config, 'token', None) or '').strip()
    if not token:
        from agent.secret_scope import get_secret
        token = (get_secret(variable, '') or '').strip()
    return token


async def _private_chat(platform: str, config, user: str) -> str:
    """The id of the user's private chat with Hermes's bot on `platform`, opened when the platform needs it."""
    if platform in ('telegram', 'signal', 'whatsapp'):
        return user
    if platform == 'discord':
        import aiohttp
        token = _token(config, 'DISCORD_BOT_TOKEN')
        if not token:
            raise RuntimeError('no Discord bot token')
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            async with session.post('https://discord.com/api/v10/users/@me/channels', json={'recipient_id': user},
                                    headers={'Authorization': 'Bot %s' % token}) as answer:
                data = await answer.json()
        if not isinstance(data, dict) or not data.get('id'):
            raise RuntimeError('Discord opened no private channel (%s)' % answer.status)
        return str(data['id'])
    if platform == 'slack':
        from plugins.platforms.slack.adapter import _resolve_slack_user_dm
        channel = await _resolve_slack_user_dm(_token(config, 'SLACK_BOT_TOKEN'), user)
        if not channel:
            raise RuntimeError('Slack opened no private conversation')
        return channel
    raise RuntimeError('the relay does not reach %s' % platform)


async def _send_on(platform: str, user: str, text: str):
    """Sends `text` to the user in their private chat on `platform`: (chat id, message id). Raises when it could not.
    A platform whose send gives no message id gets one of the relay's own: the user's replies there cannot be matched,
    their "@project" messages still reach Tars."""
    if platform == 'telegram':
        message = await _send_plain(user, text)
        return user, str(message.message_id)
    from gateway.config import Platform
    from tools.send_message_tool import _send_to_platform
    config = _gateways().get(platform)
    if config is None:
        raise RuntimeError('%s is not set up on this Hermes' % platform)
    chat = await _private_chat(platform, config, user)
    result = await _send_to_platform(Platform(platform), config, chat, text)
    if not isinstance(result, dict) or not result.get('success'):
        # Hermes's own error text, which it strips of secrets (tools/send_message_senders.py:_error).
        raise RuntimeError(str((result or {}).get('error') or 'refused')[:300])
    return chat, str(result.get('message_id') or 'unmatched:' + uuid.uuid4().hex)


@router.get('/status')
def status():
    store = _store()
    settings = _settings()
    try:
        gateways = _gateways()
    except Exception:
        log.exception('tars-relay: could not read the gateways Hermes has set up')
        gateways = {}
    seen = core.gateway_users(sorted(gateways), settings, os.environ)
    return {'plugin': core.PLUGIN_ID, 'version': core.VERSION, 'configured': bool(core.users_of(settings)),
            'sends_last_hour': store.sends_last_hour(), 'waiting_replies': store.waiting_replies(),
            'projects': store.projects(), 'store_id': store.store_id,
            'gateways': [{**gateway, 'reached': gateway['gateway'] in REACHED,
                          'sends_last_hour': store.sends_last_hour(platform=gateway['gateway'])} for gateway in seen]}


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
    users = core.users_of(_settings())
    if not users:
        raise HTTPException(status_code=503, detail='tars-relay names no user in its settings')
    if outgoing['gateway'] and outgoing['gateway'] not in users:
        raise HTTPException(status_code=400, detail='tars-relay names no user on %s' % outgoing['gateway'])
    targets = [outgoing['gateway']] if outgoing['gateway'] else sorted(users)
    store = await asyncio.to_thread(_store)
    sent, failed = {}, {}
    for platform in targets:
        user = users[platform]
        # The place is taken before the message goes out, so that sends made at once cannot all pass the count. On
        # Telegram the chat is the user's id; elsewhere the place is taken under the user's id and moved to the chat.
        slot = await asyncio.to_thread(store.reserve, user, platform)
        if slot is None:
            failed[platform] = '%d sends in the last hour already' % core.SENDS_PER_HOUR
            continue
        try:
            chat, message_id = await _send_on(platform, user, outgoing['text'])
        except Exception as error:
            await asyncio.to_thread(store.release, slot)
            # The class only: an error from an HTTP client can carry the request's URL, and a bot token is in some.
            log.warning('tars-relay: %s did not take a message (%s)', platform, type(error).__name__)
            failed[platform] = '%s did not take the message (%s)' % (platform, type(error).__name__)
            continue
        await asyncio.to_thread(store.record_sent, platform=platform, chat_id=chat, message_id=message_id,
                                ref=outgoing['ref'], kind=outgoing['kind'], project=outgoing['project'],
                                text=outgoing['text'], slot=slot)
        sent[platform] = message_id
    if not sent:
        every_hour = all(reason.endswith('in the last hour already') for reason in failed.values())
        raise HTTPException(status_code=429 if every_hour else 502,
                            detail='; '.join('%s: %s' % (name, why) for name, why in sorted(failed.items())))
    # message_id: Telegram's when it went there, as before the other gateways, for a Tars that reads only that.
    return {'message_id': sent.get('telegram') or sent[sorted(sent)[0]], 'sent': sent, 'failed': failed}


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
