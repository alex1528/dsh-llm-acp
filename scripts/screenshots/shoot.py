#!/usr/bin/env python3
"""Regenerate the README screenshots (docs/shot-*.png) from the CURRENT profile config.

Usage:  <python with playwright> scripts/screenshots/shoot.py

Starts scripts/screenshots/server.mjs, waits until every provider card is filled in, then drives the
installed Google Chrome headless. Sends no prompt (model discovery is an ACP handshake) and writes
no config. Env: NODE (node executable), plus the server's env (see server.mjs).
"""
import json
import os
import re
import subprocess
import time
import urllib.request
from os.path import abspath, dirname, join

from playwright.sync_api import sync_playwright

ROOT = dirname(dirname(dirname(abspath(__file__))))
DOCS = join(ROOT, 'docs')
NODE = os.environ.get('NODE', 'node')
# Dashboard loaded and the quiet background scan finished (the 配置 CLI tag shows its count).
READY = "() => document.body.innerText.includes('更新于') && !!document.querySelector('.acp-cfg .n')"
SCANNED = "() => /找到 \\d+ 个/.test(document.body.innerText)"


def open_disc(pg):
    """Unfold the scan card through the 配置 CLI tag and wait for its tiles."""
    pg.locator('.acp-cfg').first.click()
    pg.mouse.move(2, 2)  # no hover highlight on whatever tile scrolls under the pointer
    pg.wait_for_function(SCANNED, timeout=120000)
    pg.wait_for_timeout(1500)


def get(url, timeout=120):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


srv = subprocess.Popen([NODE, join(ROOT, 'scripts', 'screenshots', 'server.mjs')], stdout=subprocess.PIPE, text=True)
try:
    base = srv.stdout.readline().strip().split()[-1]
    print('server', base, flush=True)
    # Warm every slow probe first, so each page renders complete.
    t0 = time.time()
    while True:
        d = get(f'{base}/api/llm-acp.dashboard?range=7')
        if not d.get('pending'):
            break
        if time.time() - t0 > 150:
            print('warn: still pending after 150s', flush=True)
            break
        time.sleep(1.5)
    print('providers:', [(p['id'], p['status'], len(p.get('models') or []), (p.get('cli') or {}).get('version')) for p in d['providers']], flush=True)
    disc = get(f'{base}/api/llm-acp.discover')
    print('discover:', [(c['bin'], c.get('configuredAs')) for c in disc['candidates']], flush=True)
    session = get(f'{base}/preview/session')['session']
    print('modal session:', session, flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel='chrome', headless=True)

        def open_page(w, h, dsf, query):
            ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dsf, locale='zh-CN', timezone_id='Asia/Shanghai')
            pg = ctx.new_page()
            pg.on('pageerror', lambda e: print('pageerror:', e, flush=True))
            pg.goto(f'{base}/?{query}')
            return ctx, pg

        # 6, 1 + 4: the 配置 CLI tag with its guide dot, then the page with the scan card unfolded
        ctx, pg = open_page(1440, 900, 1.5, 'view=page')
        pg.wait_for_function(READY, timeout=120000)
        pg.wait_for_timeout(1200)
        # The hint bubble hangs below the hero card: clip a little past its bottom edge.
        pg.wait_for_selector('.acp-coach', timeout=30000)
        pg.wait_for_timeout(1300)
        box = pg.locator('.acp-hero').bounding_box()
        pg.screenshot(path=join(DOCS, 'shot-06-config-tag.png'), clip={'x': box['x'], 'y': box['y'], 'width': box['width'], 'height': box['height'] + 80})
        open_disc(pg)
        pg.screenshot(path=join(DOCS, 'shot-01-insights-page.png'), full_page=True, animations='disabled')
        pg.locator('.acp-disc-wrap').screenshot(path=join(DOCS, 'shot-04-discover.png'), animations='disabled')
        ctx.close()
        print('shot 01, 04', flush=True)

        # 2: right-sidebar console (first screen)
        ctx, pg = open_page(430, 900, 2, 'view=sidebar')
        pg.wait_for_function(READY, timeout=120000)
        pg.wait_for_timeout(1200)
        pg.screenshot(path=join(DOCS, 'shot-02-sidebar.png'), animations='disabled')
        ctx.close()
        print('shot 02', flush=True)

        # 3: /acp modal locked to one session
        if session:
            ctx, pg = open_page(1100, 900, 2, f'view=modal&session={session}')
            pg.wait_for_selector('.acp-sessionbox .acp-grid', timeout=120000)
            pg.wait_for_timeout(1500)
            pg.locator('.acp-sessionbox').screenshot(path=join(DOCS, 'shot-03-session-modal.png'), animations='disabled')
            ctx.close()
            print('shot 03', flush=True)

        # 5: provider editor, prefilled from the scan, after a connection check
        ctx, pg = open_page(1280, 1500, 2, 'view=page&full=0')
        pg.wait_for_function(READY, timeout=120000)
        open_disc(pg)
        tile = pg.locator('.acp-tile:not(.on)').filter(has_text=re.compile('opencode', re.I))
        if tile.count() == 0:
            tile = pg.locator('.acp-tile:not(.on)')
        if tile.count() > 0:
            tile.first.get_by_role('button', name='配置并添加').click()
            pg.wait_for_selector('.acp-ed')
            pg.get_by_role('button', name='检测连接').click()
            try:
                pg.wait_for_selector('.acp-probe.ok, .acp-probe.fail', timeout=60000)
            except Exception as e:  # noqa: BLE001 - keep the shot even if the probe is slow
                print('probe wait:', e, flush=True)
            pg.wait_for_timeout(800)
            pg.locator('.acp-modal-box.acp-ed').screenshot(path=join(DOCS, 'shot-05-editor.png'), animations='disabled')
            print('shot 05:', pg.locator('.acp-probe').first.inner_text()[:200].replace('\n', ' '), flush=True)
        else:
            print('shot 05 skipped: no CLI left to add', flush=True)
        ctx.close()
        browser.close()
finally:
    srv.terminate()
    try:
        srv.wait(15)
    except subprocess.TimeoutExpired:
        srv.kill()
