#!/usr/bin/env python3
"""MGU App Kit build: apps/<id>/app.json + main.js  ->  installable app.

    python3 kit/tools/build.py            # build every app in apps/
    python3 kit/tools/build.py car_vitals # just one

Produces in dist/:
    <id>@<ver>.mgu   install bundle for deploy/mgu-app-install.sh (VM and car)
    <id>@<ver>.tgz   npm-format package (the platform's preinstalled_apps format)
    <id>/            the staged tree (handy for inspection)

The RHMI layout (application.xml + uiDescription.json) is GENERATED from the
"screens" + "settings" in app.json, using only widget templates that BMW's own
apps use on this firmware (see reference/rhmi-widget-cells.md).
"""
import gzip, io, json, os, re, shutil, sys, tarfile, tempfile, uuid
from xml.sax.saxutils import escape
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_data  # noqa: E402
from localize import unicode_resources, localize_spec, load_locale, languages, credit, credit_name

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
KIT = os.path.join(ROOT, 'kit')
APPS = os.path.join(ROOT, 'apps')
DIST = os.path.join(ROOT, 'dist')
SDK = os.path.join(ROOT, 'oap-sdk')
NS = uuid.UUID('6b1d3a52-8f0e-4c4b-9a77-0d0c4d4e5f10')

LANGS = ['ar_AE', 'cs_CZ', 'da_DK', 'de_DE', 'el_GR', 'en_GB', 'en_US', 'es_ES', 'fi_FI', 'fr_FR', 'he_IL',
         'hu_HU', 'id_ID', 'it_IT', 'ja_JP', 'ko_KR', 'nb_NO', 'nl_NL', 'no_NO', 'pl_PL', 'pt_BR', 'pt_PT',
         'ro_RO', 'ru_RU', 'sk_SK', 'sl_SI', 'sv_SE', 'th_TH', 'tr_TR', 'uk_UA', 'vi_VN', 'zh_CN', 'zh_TW']

NATIVE = ['certmgr', 'codings', 'ecu', 'nare_logging', 'necemapaths', 'personalization',
          'smrf-native-cpp', 'someip', 'wscpp-client']

# Platform proxies every OAP app needs (same set BMW's apps declare).
PLATFORM_PROXIES = {
    "de.bmw.infotainment.hmi.entrypoint.EntryPoint": "*",
    "de.bmw.infotainment.hmi.entrypoint.EntryPointManager": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmi": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmiApplication": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceBundle": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceManager": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.StringBundle": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseInstance": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseProvider": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseRegistry": {
        "attributes": {"useCaseIds": "r"}, "broadcasts": ["registryUpdate"], "instances": "*", "methods": ["getProvider"]},
    "de.bmw.infotainment.lifecycle.lifecycle.Lifecycle": {"attributes": {"powerStateDetailed": "rs"}, "instances": "Front"},
    "de.bmw.infotainment.personalization.SessionManager": "*",
    "de.bmw.infotainment.personalization.UserAccount": {
        "attributes": {"firstName": "rs", "gcid": "rs", "id": "r", "name": "rs", "type": "r"},
        "broadcasts": ["requestUpdateConnectedDriveCredentials"], "instances": "*"},
    "de.bmw.infotainment.dataprivacy.privacysettings.PrivacySettings": {
        "attributes": {"allSettings": "rs"}, "instances": "1",
        "methods": ["addOrUpdateSetting", "setDynamicAvailable", "setDynamicEnable"]},
    "de.bmw.infotainment.telematic.oap.AppBookmarks": {"instances": ["${userId}"], "methods": ["registerBookmark"]},
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint": {
        "instances": ["${userId}"], "methods": ["registerEntryPoint", "unregisterEntryPoint", "setSelected", "setAvailability"]},
    "de.bmw.infotainment.telematic.oap.WakeUpOnDemand": {"instances": ["${userId}"], "methods": ["registerParticipant", "unregisterParticipant"]},
    "de.bmw.infotainment.telematic.oap.WodControl": {"instances": "${userId}", "methods": ["offerService", "stopOfferingService"]},
    "de.bmw.infotainment.telematic.oapcontroller.OAPController": "*",
    "de.bmw.infotainment.telematic.provisioning.Provisioning": {
        "broadcasts": ["provisioningDataJSON"], "instances": "1", "methods": ["getValueJSON", "setFilterForProvisioningData"]},
    "de.bmw.infotainment.vehicle.Vehicle": {"attributes": {"statusNewCurrentUnitsStatusExt": "rs"}, "instances": "1"},
    "de.bmw.infrastructure.EnvironmentalInformation": {"attributes": {"UnitBN2020": "rs"}, "instances": "1"},
    "org.genivi.nodestatemanager.Consumer": {
        "broadcasts": ["ShutdownEvents", "SessionStateChanged"], "instances": "NSMConsumer",
        "methods": ["LifecycleRequestComplete", "RegisterShutdownClient", "UnRegisterShutdownClient"]},
}
# iDrive 8 (MainApp-21, Hmi8): the platform interfaces exactly as IterioDev's car-tested iDrive 8 apps declare them
# (github.com/IterioDev/car-apps: the HMI's "2" interfaces beside the iDrive 7 ones, the certification service MainApp-21
# installs every app's keychain with, UserAccountManager). The iDrive 7 set's Lifecycle, PrivacySettings and UserAccount
# are left out: the deploy tool takes interfaces a unit lacks out of a manifest on iDrive 7 only.
ID8_PROXIES = {
    "de.bmw.infotainment.certification.Certification": "*",
    "de.bmw.infotainment.hmi.entrypoint.EntryPoint": "*",
    "de.bmw.infotainment.hmi.entrypoint.EntryPointManager": "*",
    "de.bmw.infotainment.hmi.entrypoint2.EntryPoint2": "*",
    "de.bmw.infotainment.hmi.entrypoint2.EntryPointManager2": "*",
    "de.bmw.infotainment.hmi.hmicontext.HMIContext": {"instances": ["HMI_CID"], "attributes": {"currentDisplayLanguage": "rs"}},
    "de.bmw.infotainment.hmi.hmicontext2.HMIContext2": {"instances": ["1"], "attributes": {"currentDisplayLanguage": "rs"}},
    "de.bmw.infotainment.hmi.remote.RemoteHmi": "*",
    "de.bmw.infotainment.hmi.remote.RemoteHmiApplication": "*",
    "de.bmw.infotainment.hmi.remote2.RemoteHmi2": "*",
    "de.bmw.infotainment.hmi.remote2.RemoteHmiApplication2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceBundle": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.ResourceManager": "*",
    "de.bmw.infotainment.hmi.resourcemanagement.StringBundle": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.ResourceBundle2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.ResourceManager2": "*",
    "de.bmw.infotainment.hmi.resourcemanagement2.StringBundle2": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseContext": {"instances": "*", "broadcasts": ["notify"], "methods": ["setObservedContextKeys"]},
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseInstance": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseProvider": "*",
    "de.bmw.infotainment.hmi.usecasemanagement.UseCaseRegistry": {
        "instances": "*", "attributes": {"useCaseIds": "r"}, "broadcasts": ["registryUpdate"], "methods": ["getProvider"]},
    "de.bmw.infotainment.personalization.SessionManager": "*",
    "de.bmw.infotainment.personalization.UserAccountManager": "*",
    "de.bmw.infotainment.telematic.oap.AppBookmarks": {"instances": ["${userId}"], "methods": ["registerBookmark"]},
    "de.bmw.infotainment.telematic.oap.AppStatus": "*",
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint": {
        "instances": ["${userId}"], "methods": ["registerEntryPoint", "unregisterEntryPoint", "setSelected", "setAvailability"]},
    "de.bmw.infotainment.telematic.oap.PrivateEntryPoint2": {"instances": ["${userId}"], "methods": ["genericMethod"]},
    "de.bmw.infotainment.telematic.oap.WakeUpOnDemand": {"instances": ["${userId}"], "methods": ["registerParticipant", "unregisterParticipant"]},
    "de.bmw.infotainment.telematic.oap.WodControl": {"instances": "${userId}", "methods": ["offerService", "stopOfferingService"]},
    "de.bmw.infotainment.telematic.oapcontroller.OAPController": "*",
    "de.bmw.infotainment.telematic.provisioning.Provisioning": {
        "instances": "1", "broadcasts": ["provisioningDataJSON"], "methods": ["getValueJSON", "setFilterForProvisioningData"]},
    "de.bmw.infotainment.vehicle.Vehicle": "*",
    "de.bmw.infrastructure.EnvironmentalInformation": "*",
    "org.genivi.nodestatemanager.Consumer": {
        "instances": "NSMConsumer", "broadcasts": ["ShutdownEvents", "SessionStateChanged"],
        "methods": ["LifecycleRequestComplete", "RegisterShutdownClient", "UnRegisterShutdownClient"]},
}
ID8_SERVICES = {"de.bmw.infotainment.telematic.oap.AppStatus": {"instances": ["${userId}"]}}
PLATFORM_SERVICES = {
    "de.bmw.infotainment.telematic.oap.AppStatus": {"instances": ["${userId}"]},
    "de.bmw.infotainment.telematic.oap.TriggersControl": {"instances": ["${userId}"]},
}

# property ids (RhmiConstants): Enabled=1 Visible=2 Focusable=3 ParentState=9
WIDGETS = {
    'graphic':   ('label', 'LT_Label_1Graphic_Scalable', {2: 1, 3: 0}),
    # Focusable=3: the HMI then reports focus changes (the kit's slim bar shows the focused button)
    'barbutton': ('button', 'LT_Button_1Row_Laptimer', {3: 3}),
    'header':    ('label', 'LT_Label_Header_1Row', {2: 1, 3: 0}),
    'text':      ('label', 'LT_Label_1Row', {2: 1, 3: 0}),
    'text3':     ('label', 'LT_Label_3Row_1TextDyn', {2: 1, 3: 0}),
    # menu rows: Visible=1, Focusable=2 - as in BMW's smartinterior menus
    'button':    ('button', 'LT_Button_1Row', {2: 1, 3: 2}),
    'iconbutton': ('button', 'LT_Button_1Row_1IconLeft', {2: 1, 3: 2}),
    'twocol':    ('button', 'LT_Button_1Row_2Col7030_2Text', {2: 1, 3: 2}),
    # settings: label on the 1st row, value on the 2nd, each the full width (BMW's parking app
    # settings use it in an LT_State_Wide); the 70/30 one-row columns cut both off
    'tworow':    ('button', 'LT_Button_2Row_2Text', {2: 1, 3: 2}),
    'checkbox':  ('checkBox', 'LT_CheckBox_1Row', {2: 1, 3: 2}),
    'scroll':    ('label', 'LT_ScrollLabel_UnlimitedRow_TextDyn', {2: 1, 3: 1}),
    'laptimer':  ('label', 'LT_Label_Laptimer', {3: 0}),
}


def u(app, what):
    return str(uuid.uuid5(NS, app + ':' + what))


class Ids:
    def __init__(self):
        self.n = 0

    def __call__(self):
        self.n += 1
        return self.n


def sid(app, key):
    return 'SID_' + re.sub(r'[^A-Z0-9]+', '_', (app + '_' + key).upper()).strip('_')


def hmi_text(s):
    """Keep Unicode: unicode_resources converts these cells to StringId before packaging."""
    return str(s)


def setting_options(s):
    """(values, labels) of a choice / number setting, in order - the drop-down's rows.
    "markDefault": true adds " (default)" to the default's row; "labels": {"0": "Auto"} names
    single number values (shown as is, no unit)."""
    if s['type'] == 'choice':
        values, labels = [o[0] for o in s['options']], [o[1] for o in s['options']]
    else:
        steps = s.get('steps') or []
        unit = (' ' + s['unit']) if s.get('unit') else ''
        named = s.get('labels') or {}
        values, labels = list(steps), [named.get('%g' % v, ('%g' % v) + unit) for v in steps]
    if s.get('markDefault'):
        labels = [lb + ' (default)' if v == s.get('default') else lb for v, lb in zip(values, labels)]
    return values, labels



def fetch_assets(adir, assets):
    """Large files an app needs but git doesn't keep (app.json "assets"): downloaded once, checked by SHA-256."""
    import hashlib, io, urllib.request, zipfile
    sha = lambda b: hashlib.sha256(b).hexdigest()
    for a in assets:
        dst = os.path.join(adir, a['file'])
        if os.path.exists(dst) and sha(open(dst, 'rb').read()) == a['sha256']:
            continue
        print('  fetching %s from %s' % (a['file'], a['url']))
        data = urllib.request.urlopen(a['url'], timeout=300).read()
        if a.get('zipSha256') and sha(data) != a['zipSha256']:
            sys.exit('%s: download does not match its SHA-256' % a['url'])
        if a.get('zipMember'):
            data = zipfile.ZipFile(io.BytesIO(data)).read(a['zipMember'])
        if sha(data) != a['sha256']:
            sys.exit('%s: file does not match its SHA-256' % a['file'])
        open(dst, 'wb').write(data)


def build_ui(spec, language='en'):
    """screens/settings -> (application.xml, uiDescription.json, strings, screen meta)"""
    app = spec['id']
    nid = Ids()
    strings = {sid(app, 'TITLE'): spec['title']}
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>']
    ui = {'schemaVersion': '1.3.0', 'containers': {}}
    screens = list(spec.get('screens', []))
    # a "menu" screen with "settings": true shows the settings itself: no separate settings screen
    if spec.get('settings') and not any(sc.get('settings') is True for sc in screens):
        screens.append({'name': 'SETTINGS', 'kind': 'settings', 'title': 'Settings'})
    state_ids = {}
    for scr in screens:
        state_ids[scr['name']] = None
    main_id = None

    def comp(kind, name, rows=None, extra_props=None, cells=None):
        ctype, widget, props = WIDGETS[kind]
        cid = nid()
        p = dict(props)
        p.update(extra_props or {})
        x = [f'            <component id="{cid}" type="{ctype}" widget="{widget}">']
        x += [f'                <property id="{k}" value="{v}"/>' for k, v in p.items()]
        x.append('            </component>')
        c = {'type': ctype, 'name': name}
        pj = {}
        if 2 in p: pj['Visible'] = {'value': p[2], 'type': 'UInt'}
        if 3 in p: pj['Focusable'] = {'value': p[3], 'type': 'UInt'}
        if pj: c['properties'] = pj
        if rows is not None: c['rows'] = rows
        if cells is not None: c['cells'] = cells
        return cid, x, c

    def text_row(key, text, cell='Text'):
        s = sid(app, key)
        strings[s] = text
        return {cell: {'value': s, 'type': 'StringId'}}

    def settings_items(items):
        for s in spec['settings']:
            name = 'SET_' + s['key'].upper()
            if s['type'] == 'bool':
                items.append(comp('checkbox', name, rows=[text_row('SET_' + s['key'], s['label'])]))
            elif s['type'] in ('choice', 'number'):
                # a drop-down with every value, as BMW's parking app settings: rows = options
                # (ItemText), HeaderText = the setting, SelectedItem = the chosen row (mgu.js sets it)
                values, labels = setting_options(s)
                did = nid()
                items.append((did, [f'            <component id="{did}" type="dropDownMenu"/>'], {
                    'type': 'dropDownMenu', 'name': name,
                    'rows': [{'ItemText': {'value': hmi_text(lb), 'type': 'Text'}} for lb in labels],
                    'cells': {'HeaderText': {'value': hmi_text(s['label']), 'type': 'Text'},
                              'SelectedItem': {'value': values.index(s['default']) if s['default'] in values else 0, 'type': 'UInt'}},
                }))
            else:
                strings[sid(app, 'SET_' + s['key'])] = s['label']
                items.append(comp('tworow', name, rows=[{'Text1stRow': {'value': s['label'], 'type': 'Text'},
                                                        'Text2ndRow': {'value': '', 'type': 'Text'}}]))
        # Translated builds with a credit file only: credit for the translation (localize.py keeps its title)
        if credit(language):
            name = credit_name(language)
            credit_title, credit_link = sid(app, name + '_TITLE'), sid(app, name + '_LINK')
            strings[credit_title], strings[credit_link] = credit(language)['settingsTitle'], credit(language)['settingsLink']
            items.append(comp('tworow', name, rows=[{
                'Text1stRow': {'value': credit_title, 'type': 'StringId'},
                'Text2ndRow': {'value': credit_link, 'type': 'StringId'},
            }]))
        # the project's own credit, last row
        repo_title, repo_link = sid(app, 'REPO_CREDITS_TITLE'), sid(app, 'REPO_CREDITS_LINK')
        strings[repo_title] = 'iDrive 7 custom apps'
        strings[repo_link] = 'GitHub cauliflowermossgrape · github.com/cauliflowermossgrape/idrive7-apps'
        items.append(comp('tworow', 'REPO_CREDITS', rows=[{
            'Text1stRow': {'value': repo_title, 'type': 'StringId'},
            'Text2ndRow': {'value': repo_link, 'type': 'StringId'},
        }]))

    for scr in screens:
        cid = nid()
        state_ids[scr['name']] = cid
        kind = scr.get('kind', 'list')
        # canvas = M Laptimer's state; menus = the state BMW uses for its
        # clickable lists (LT_State_Wide only renders a single text block)
        # settings: the wide state (full screen width), as BMW's own settings lists
        # menu: an app's own main menu (buttons, then its settings), in the same wide state
        widget = 'LT_State_Laptimer' if kind == 'canvas' else 'LT_State_Wide' if kind in ('settings', 'menu') else 'LT_State_Regular_ContentHidden'
        cont = {'type': 'state', 'name': scr['name'], 'components': {}}
        x = [f'    <container id="{cid}" type="state" widget="{widget}">']
        if main_id is not None and scr.get('parent', True):
            x.append(f'        <property id="9" value="{main_id}"/>')
            cont['properties'] = {'ParentState': {'value': main_id, 'type': 'UInt'}}
        groups = []
        if kind == 'canvas':
            items = []
            gid, gx, gc = comp('graphic', scr.get('graphic', scr['name'] + '_GFX'), rows=[{'Graphic': {'value': '', 'type': 'Text'}}])
            items.append((gid, gx, gc))
            groups.append(('List', items))
            bar = []
            for b in scr.get('buttons', []):
                bid, bx, bc = comp('barbutton', b[0], rows=[text_row(b[0], b[1])])
                bar.append((bid, bx, bc))
            if bar:
                groups.append(('Bar', bar))
        elif kind == 'settings':
            items = []
            settings_items(items)
            groups.append(('List', items))
        else:   # list / menu: components from "items" (a menu adds the settings after them)
            items = []
            for it in scr.get('items', []):
                kindi, name = it[0], it[1]
                label = it[2] if len(it) > 2 else ''
                if kindi == 'twocol':
                    rows = [{'Text1stCol': {'value': label, 'type': 'Text'}, 'Text2ndCol': {'value': '', 'type': 'Text'}}]
                elif kindi in ('graphic',):
                    rows = [{'Graphic': {'value': '', 'type': 'Text'}}]
                elif kindi == 'laptimer':
                    rows = [{}]
                else:
                    rows = [text_row(name, label)] if label else [{'Text': {'value': '', 'type': 'Text'}}]
                items.append(comp(kindi, name, rows=rows))
            if kind == 'menu' and scr.get('settings'):
                settings_items(items)
            groups.append(('List', items))
        tid = nid()
        groups.append(('Titlebar', [(tid, [f'            <component id="{tid}" type="title"/>'],
                                     {'type': 'title', 'name': scr['name'] + '_TITLE', 'rows': [text_row(scr['name'] + '_TITLE', scr.get('title', spec['title']))]})]))
        for gname, items in groups:
            gid = nid()
            x.append(f'        <layoutGroup id="{gid}" name="{gname}">')
            if gname != 'Titlebar':
                x.append('            <property id="3" value="1"/>')
            for (ccid, cx, cc) in items:
                x += cx
                cont['components'][str(ccid)] = cc
            x.append('        </layoutGroup>')
        x.append('    </container>')
        xml += x
        ui['containers'][str(cid)] = cont
        if main_id is None:
            main_id = cid
    # optional pop-ups (app.json "popups"): a container of the pop-up type with one dynamic text label,
    # <name>_TEXT, and an optional button, <name>_OK; stackConsumer="false" as BMW's x_call does, so the
    # pop-up never joins the HMI's screen stack (the app's own screen visibility stays as it was)
    for pop in spec.get('popups', []):
        cid = nid()
        state_ids[pop['name']] = cid
        lid, lx, lc = comp(pop.get('label', 'text3'), pop['name'] + '_TEXT', rows=[{'Text': {'value': '', 'type': 'Text'}}])
        cx_all, comps = lx, {str(lid): lc}
        if pop.get('button'):   # x_call's button: visible, focusable 3, enabled
            bid, bx, bc = comp('button', pop['name'] + '_OK', rows=[text_row(pop['name'] + '_OK', pop['button'])], extra_props={3: 3, 1: 1})
            cx_all, comps[str(bid)] = cx_all + bx, bc
        # every BMW pop-up gives its label and button a focusId (the HMI puts the focus there); without one the
        # HMI closed ours again at once. Ours: 0x7000 + the component id, clear of BMW's 2xxxx range
        cx_all = [l.replace('" widget=', f'" focusId="{28672 + int(l.split(chr(34))[1])}" widget=', 1) if '<component id=' in l else l for l in cx_all]
        gid, tgid, tid = nid(), nid(), nid()
        comps[str(tid)] = {'type': 'title', 'name': pop['name'] + '_TITLE', 'rows': [text_row(pop['name'] + '_TITLE', pop.get('title', spec['title']))]}
        xml += [f'    <container id="{cid}" type="{pop["type"]}" widget="{pop["widget"]}" stackConsumer="false">',
                f'        <layoutGroup id="{gid}" name="List">', '            <property id="3" value="1"/>'] + cx_all + ['        </layoutGroup>',
                f'        <layoutGroup id="{tgid}" name="Titlebar">', f'            <component id="{tid}" type="title"/>', '        </layoutGroup>', '    </container>']
        ui['containers'][str(cid)] = {'type': pop['type'], 'name': pop['name'], 'components': comps}
    xml.append('</application>')
    return '\n'.join(xml) + '\n', ui, strings, state_ids


def build_ui_id8(spec):
    """iDrive 8: the HMI keeps no screen of ours but an empty host page per drawn ("canvas") screen - the GPU renderer
    draws the whole screen over it, as IterioDev's car-tested iDrive 8 apps do (one LT_State_Wide_List state, its title
    bar, an empty list; a logical container with the bookmark). Menus, settings screens, pop-ups and widgets are not
    made: the app draws those (the kit's sheets). -> (application.xml, uiDescription.json, strings, state ids)"""
    app = spec['id']
    strings = {sid(app, 'TITLE'): spec['title']}
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>',
           '    <container id="1000" type="logical">', '        <layoutGroup id="1100">',
           '            <component id="1110" type="bookmark"/>', '        </layoutGroup>', '    </container>']
    ui = {'schemaVersion': '1.3.0', 'containers': {'1000': {'type': 'logical', 'name': 'logicalContainer',
                                                           'components': {'1110': {'type': 'bookmark', 'name': 'bookmark'}}}}}
    state_ids = {}
    for i, scr in enumerate(s for s in spec.get('screens', []) if s.get('kind') == 'canvas'):
        cid = 3000 + 1000 * i
        state_ids[scr['name']] = cid
        key = scr['name'] + '_TITLE'
        strings[sid(app, key)] = scr.get('title', spec['title'])
        # four status lines in the page's list (labels as the Store's iDrive 8 pages have them): the renderer's
        # surface covers them while it draws; when it does not they say why, instead of an empty grey page. Their
        # first text is the package's own, so it shows even when the app's code never ran.
        lines = [('INFO1', '%s %s for iDrive 8' % (spec['title'], spec['version'])),
                 ('INFO2', 'Starting... If this text stays, the app did not start. Please send a photo of this screen.'),
                 ('INFO3', 'Renderer: not asked yet'),
                 ('INFO4', 'App: not started yet')]
        xml += [f'    <container id="{cid}" type="state" widget="LT_State_Wide_List">',
                f'        <layoutGroup id="{cid + 200}" name="Titlebar">',
                f'            <component id="{cid + 220}" type="title">', '                <property id="2" value="1"/>',
                '            </component>', '        </layoutGroup>',
                f'        <layoutGroup id="{cid + 400}" name="List">', '            <property id="3" value="1"/>']
        comps = {str(cid + 220): {'type': 'title', 'name': key, 'rows': [{'Text': {'value': sid(app, key), 'type': 'StringId'}}]}}
        for j, (suffix, text) in enumerate(lines):
            lid, lkey = cid + 410 + 10 * j, scr['name'] + '_' + suffix
            strings[sid(app, lkey)] = text
            xml += [f'            <component id="{lid}" type="label" widget="LT_ScrollLabel">',
                    '                <property id="2" value="1"/>', '                <property id="3" value="0"/>',
                    '            </component>']
            comps[str(lid)] = {'type': 'label', 'name': lkey,
                               'properties': {'Visible': {'value': 1, 'type': 'UInt'}, 'Focusable': {'value': 0, 'type': 'UInt'}},
                               'rows': [{'Text': {'value': sid(app, lkey), 'type': 'StringId'}}]}
        xml += ['        </layoutGroup>', '    </container>']
        ui['containers'][str(cid)] = {'type': 'state', 'name': scr['name'], 'components': comps}
    if not state_ids:
        sys.exit('%s: iDrive 8 needs a "canvas" screen (the page the renderer draws)' % app)
    xml.append('</application>')
    return '\n'.join(xml) + '\n', ui, strings, state_ids


def manifest_for(spec, hmi='ID7'):
    proxies = dict(ID8_PROXIES if hmi == 'ID8' else PLATFORM_PROXIES)
    for iface, fields in spec.get('signals', {}).items():
        if hmi == 'ID8':
            # the whole interface, as IterioDev's car-tested iDrive 8 apps name the car's (Vehicle2, CDS): the kit
            # reads them through the SDK's typed proxies there (signals.js)
            proxies[iface] = '*'
            continue
        inst = fields.pop('_instances', '1') if isinstance(fields, dict) else '1'
        entry = {'instances': inst}
        if isinstance(fields, dict):
            attrs = {k: v for k, v in fields.items() if not k.startswith('_')}
            meths = fields.get('_methods')
            evts = fields.get('_broadcasts')
            if attrs: entry['attributes'] = attrs
            if meths: entry['methods'] = meths
            if evts: entry['broadcasts'] = evts
        else:
            entry = '*'
        proxies[iface] = entry
    return {'proxies': proxies, 'services': ID8_SERVICES if hmi == 'ID8' else PLATFORM_SERVICES}


def make_icon(spec, out):
    src = os.path.join(APPS, spec['id'], 'icon.png')
    if os.path.exists(src):
        shutil.copy(src, out)
        return
    # rendered by the kit's own canvas (node) so no extra tooling is needed
    os.system(f'node "{os.path.join(HERE, "make_icon.js")}" "{spec.get("iconGlyph", spec["title"][:2])}" "{out}"')


WIDGET_COMPONENT_ID = 501


def build_start_widget(spec, app_id, icon_src, out):
    """app.json "startWidget" -> rhmiDataStartWidget/ (installed format), the home-screen widget.

    Same shape as BMW's own widgets on this firmware (Drive Recorder, Weather, News): a logical
    container with one startWidget component whose "Widget" cell names an HMI layout template.
    MainApp finds the folder by itself and offers the widget in the home screen's widget list;
    the app fills each placed widget (one "spawn" per widget) at runtime (kit/runtime/mgu.js)."""
    sw = spec['startWidget']
    name = sw.get('name', spec['title'])
    comp = app_id.upper() + '_WIDGET'
    sid_name = sid(app_id, 'WIDGET_NAME')
    icon = app_id + '_widget_icon.png'
    wuuid = u(app_id, 'start-widget')
    shutil.rmtree(out, ignore_errors=True)
    for d in ('uiDescription', 'strings', 'resources'):
        os.makedirs(os.path.join(out, d))
    app_json = {'schemaVersion': '1.3.0', 'application': {
        'uuid': wuuid, 'type': 'StartWidget', 'name': app_id + '_widget', 'vendor': spec.get('vendor', 'custom'),
        'version': '1.0', 'defaultLanguage': 'en_GB',
        'stringBundleUuid': u(app_id, 'sw-strings'), 'resourceBundleUuid': u(app_id, 'sw-resources'), 'entryPoints': [],
        'entryPointsStringBundleUuid': u(app_id, 'sw-ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'sw-ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'sw-ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'sw-bookmarks'), 1, 2, 3, 4, 5, 6, 7]}}
    json.dump(app_json, open(os.path.join(out, 'application.json'), 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<application>\n'
           '    <container id="500" type="logical">\n        <layoutGroup id="502">\n'
           f'            <component id="{WIDGET_COMPONENT_ID}" type="startWidget">\n'
           f'                <property id="7" value="{wuuid}"/>\n'
           '            </component>\n        </layoutGroup>\n    </container>\n</application>\n')
    open(os.path.join(out, 'uiDescription', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    ui = {'schemaVersion': '1.3.0', 'containers': {'500': {'type': 'logical', 'name': 'startWidgetLogical', 'components': {
        str(WIDGET_COMPONENT_ID): {'type': 'startWidget', 'name': comp,
                                   'properties': {'UUID': {'value': wuuid, 'type': 'Text'}},
                                   'cells': {'Widget': {'value': sw.get('layout', 'LT_Table_OnlineApps_DriveRecorderWidget'), 'type': 'Text'},
                                             'SelectionName': {'value': sid_name, 'type': 'StringId'},
                                             'SelectionIcon': {'value': icon, 'type': 'ResourceId'}}}}}}}
    json.dump(ui, open(os.path.join(out, 'uiDescription', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
        json.dump({sid_name: name}, open(os.path.join(out, 'strings', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    shutil.copy(icon_src, os.path.join(out, 'resources', icon))
    return {'component': comp, 'layout': ui['containers']['500']['components'][str(WIDGET_COMPONENT_ID)]['cells']['Widget']['value']}


# iDrive 8: what an app may reach over joynr there (permissions.json), by domain and interface: the entries of the MGU
# Store's own app and of the iDrive 8 apps that run beside it. iDrive 7's table (kit/platform/permissions.json) names
# the gateway interfaces of that head unit.
ID8_ACCESS = [
    ('hmi.entrypoint2', 'de/bmw/infotainment/hmi/entrypoint2/EntryPointManager2'),
    ('hmi.resourcemanagement2', 'de/bmw/infotainment/hmi/resourcemanagement2/ResourceManager2'),
    ('hmi.resourcemanagement2', 'de/bmw/infotainment/hmi/resourcemanagement2/StringBundle2'),
    ('hmi.usecasemanagement', 'de/bmw/infotainment/hmi/usecasemanagement/UseCaseContext'),
    ('telematic.oapcontroller', 'de/bmw/infotainment/telematic/oapcontroller/OAPController'),
    ('de.bmw.infotainment.telematic.oap.oapcontroller', 'de/bmw/infotainment/telematic/oapcontroller/OAPController'),
    ('de.bmw.infotainment.telematic.oap.appStatus_${APPNAME}', 'de/bmw/infotainment/telematic/oap/appstatus/AppStatus'),
    ('de.bmw.infotainment.telematic.oap.appstart', 'de/bmw/infotainment/telematic/oap/appstart/AppStart'),
    ('de.bmw.infotainment.telematic.oap.privateEntryPoint_${APPNAME}',
     'de/bmw/infotainment/telematic/oap/privateentrypoint/PrivateEntryPoint'),
]
ID8_REGISTRATION = [('de.bmw.infotainment.telematic.oap.heartbeat_${APPNAME}',
                     'de/bmw/infotainment/telematic/oap/heartbeat/HeartbeatMonitor')]
# the require names the head unit's linker resolves in an app already on the car (kit/id8/boot.js asks for these three)
ID8_SDK = ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders']
# where the kit and the app's own code go in the iDrive 8 package (kit/id8/boot.js RUNTIME)
ID8_RUNTIME = 'app'
# a package file that asks for the SDK by a require call: the MGU Store's deploy tool gives no SDK module on iDrive 8,
# and refuses a built package that still has one (its tools/oap_link.js needsSdk)
SDK_CALL = re.compile(r"""require\(\s*(['"])oap-sdk\1\s*\)""")


def permissions_id8():
    def entry(kind, domain, iface):
        e = {'_typeName': 'joynr.infrastructure.DacTypes.Master%sControlEntry' % kind, 'uid': '${APPNAME}',
             'domain': domain, 'interfaceName': iface, 'defaultRequiredTrustLevel': 'HIGH',
             'possibleRequiredTrustLevels': [], 'defaultRequiredControlEntryChangeTrustLevel': 'HIGH',
             'possibleRequiredControlEntryChangeTrustLevels': []}
        if kind == 'Access':
            e.update({'operation': '*', 'defaultConsumerPermission': 'YES', 'possibleConsumerPermissions': []})
        else:
            e.update({'defaultProviderPermission': 'YES', 'possibleProviderPermissions': []})
        return e
    return {'masterAccessTable': [entry('Access', d, i) for d, i in ID8_ACCESS], 'mediatorAccessTable': [],
            'ownerAccessTable': [], 'masterRegistrationTable': [entry('Registration', d, i) for d, i in ID8_REGISTRATION],
            'mediatorRegistrationTable': [], 'ownerRegistrationTable': [], 'domainRoleTable': []}


def source_package_id8(spec, stage, pkg):
    """iDrive 8: the app as a source package (mgu-app.json), the only kind of package the MGU Store's deploy tool
    gives BMW's oap-sdk on iDrive 8: it links the modules mgu-app.json lists against the SDK of an app already on the
    car. One module is linked, the kit's entry module (kit/id8/boot.js); the kit and the app's code are plain files of
    the package (ID8_RUNTIME), with kit/id8/sdk.js as the kit's sdk.js. The layout is the one of the Store's own app
    (github.com/robertnisipeanu/mgu-store docs/PUBLISHING.md, "Source packages"):

        mgu-app.json                 schema 1: id, version, tree, modules, sdk
        src/boot.js                  the entry module
        <id>@<version>/              the tree: package.json (main javascript/runner.js: the head unit puts the entry
                                     point of the app it takes the SDK from there, and the linked bundle beside it as
                                     javascript/app.js), manifest.json, permissions.json, npm-shrinkwrap.json, rhmiData/
                                     (package format), app/ (the kit and the app), the licences

    -> dist/src/<id>/ and dist/src/<id>@<version>.tgz (the Store's artifact; "build": "unit" in the catalog)."""
    app_id, ver = spec['id'], spec['version']
    src = os.path.join(stage, 'source')
    out = os.path.join(DIST, 'src', app_id)
    shutil.rmtree(out, ignore_errors=True)
    tree = os.path.join(out, '%s@%s' % (app_id, ver))
    os.makedirs(os.path.join(out, 'src'))
    os.makedirs(tree)
    shutil.copy(os.path.join(KIT, 'id8', 'boot.js'), os.path.join(out, 'src', 'boot.js'))
    # the kit and the app: the staged javascript/ (app.js is the bundle's name in the package: the app's is main.js)
    run = os.path.join(tree, ID8_RUNTIME)
    shutil.copytree(os.path.join(src, 'javascript'), run)
    os.rename(os.path.join(run, 'app.js'), os.path.join(run, 'main.js'))
    shutil.copy(os.path.join(KIT, 'id8', 'sdk.js'), os.path.join(run, 'kit', 'sdk.js'))
    shutil.copytree(os.path.join(src, 'rhmiData'), os.path.join(tree, 'rhmiData'))
    shutil.copy(os.path.join(src, 'manifest.json'), os.path.join(tree, 'manifest.json'))
    files = ['javascript', 'manifest.json', 'package.json', 'permissions.json', 'npm-shrinkwrap.json', 'rhmiData', ID8_RUNTIME]
    for name in ('LICENSE', 'LICENSE.kit', 'THIRD_PARTY_LICENSES'):
        if os.path.exists(os.path.join(src, name)):
            shutil.copy(os.path.join(src, name), os.path.join(tree, name))
            files.append(name)
    json.dump(permissions_id8(), open(os.path.join(tree, 'permissions.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    json.dump({'name': app_id, 'version': ver, 'lockfileVersion': 1, 'requires': True, 'dependencies': {}},
              open(os.path.join(tree, 'npm-shrinkwrap.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    pkg8 = {'name': app_id, 'version': ver, 'description': pkg['description'], 'private': False,
            'main': 'javascript/runner.js', 'mguHmi': ['ID8'], 'oapAppSettings': pkg['oapAppSettings'], 'files': files,
            'dependencies': {'oap-sdk': '24.10.2'}, 'engines': pkg['engines'], 'author': pkg['author'],
            'license': pkg['license'], 'mguLocalOnly': True, 'productName': spec['title']}
    if pkg.get('mguAppStartType'):
        pkg8['mguAppStartType'] = pkg['mguAppStartType']
    json.dump(pkg8, open(os.path.join(tree, 'package.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    json.dump({'schema': 1, 'id': app_id, 'version': ver, 'tree': os.path.basename(tree), 'modules': ['src/boot.js'], 'sdk': ID8_SDK},
              open(os.path.join(out, 'mgu-app.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    # what would leave the app without its SDK on the car, caught here
    boot = open(os.path.join(out, 'src', 'boot.js'), encoding='utf-8').read()
    names = set(re.findall(r"require\('([^']+)'\)", boot))
    extra = sorted(n for n in names if n not in ID8_SDK and n not in ('fs', 'path'))
    if extra or not set(ID8_SDK) <= names:
        sys.exit('%s: kit/id8/boot.js may require only fs, path and %s by name (it names %s)'
                 % (app_id, ', '.join(ID8_SDK), ', '.join(extra) or 'too few'))
    members = []
    for base, _, found in os.walk(out):
        for n in found:
            f = os.path.join(base, n)
            members.append(os.path.relpath(f, out).replace(os.sep, '/'))
            if n.endswith('.js') and f != os.path.join(out, 'src', 'boot.js') and SDK_CALL.search(open(f, encoding='utf-8').read()):
                sys.exit('%s: %s asks for the oap-sdk by a require call - on iDrive 8 the SDK comes through kit/sdk.js'
                         % (app_id, members[-1]))
    archive = os.path.join(DIST, 'src', '%s@%s.tgz' % (app_id, ver))
    mtime = int(os.environ.get('SOURCE_DATE_EPOCH') or 1760745600)
    with gz_header_free(archive) as gz, tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tf:
        for name in sorted(members):
            info = tarfile.TarInfo(name)
            data = open(os.path.join(out, name), 'rb').read()
            info.size, info.mode, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), 0o644, mtime, 0, 0, '', ''
            tf.addfile(info, io.BytesIO(data))
    return archive, len(members)


def build(app_id, language='en', hmi='ID7'):
    """hmi 'ID8': the iDrive 8 package of the app, under the id app.json's "id8" names (its own Store entry: iDrive 7
    requirements such as the controller gate are not for iDrive 8). The app's code and the kit are the same; the kit
    reads "hmi" in app-spec.json."""
    src_id = app_id
    spec = json.load(open(os.path.join(APPS, app_id, 'app.json'), encoding='utf-8'))
    spec = localize_spec(spec, language)
    spec.setdefault('id', app_id)
    if hmi == 'ID8':
        id8 = spec.get('id8')
        if not id8 or not id8.get('id'):
            sys.exit('%s: no "id8": {"id": ...} in app.json - not built for iDrive 8' % app_id)
        app_id = spec['id'] = id8['id']
        spec.update({k: v for k, v in id8.items() if k != 'id'})
        spec['screens'] = [s for s in spec.get('screens', []) if s.get('kind') == 'canvas']
        spec.pop('popups', None)
        spec.pop('startWidget', None)
    ver = spec['version']
    stage = os.path.join(DIST, app_id)
    shutil.rmtree(stage, ignore_errors=True)
    src = os.path.join(stage, 'source')
    os.makedirs(os.path.join(src, 'javascript', 'kit'))
    os.makedirs(os.path.join(src, 'config'))
    os.makedirs(os.path.join(src, 'node_modules', 'oap-sdk'))
    # the licences travel with the package: the repo's own, the kit's (MIT), the third-party ones (fonts too)
    for name, out in (('LICENSE', 'LICENSE'), ('THIRD_PARTY_LICENSES', 'THIRD_PARTY_LICENSES'), ('kit/LICENSE', 'LICENSE.kit')):
        if os.path.exists(os.path.join(ROOT, name)):
            shutil.copy(os.path.join(ROOT, name), os.path.join(src, out))

    manifest = manifest_for(json.loads(json.dumps(spec)), hmi)
    xml, uidesc, strings, state_ids = build_ui_id8(spec) if hmi == 'ID8' else build_ui(spec, language)
    unicode_resources(uidesc, strings, language)
    if hmi == 'ID8':
        # the string bundle as IterioDev's iDrive 8 apps have it: the page's own texts only (the kit writes plain
        # ASCII into the page's status lines there, never through the dynamic string slots)
        strings = {k: v for k, v in strings.items() if not k.startswith('SID_CN_DYNAMIC_')}
    for lang, tbl in spec.get('strings', {}).items():
        strings.update(tbl)

    # --- source/ (the npm package) ---
    pkg = {
        'name': app_id, 'version': ver, 'description': spec.get('description', spec['title']),
        'main': 'javascript/app.js', 'private': False, 'author': spec.get('vendor', 'custom'), 'license': spec.get('license', 'UNLICENSED'),
        'engines': {'node': '>=8.7.0'},
        'oapAppSettings': {
            'maxDiskUsage': spec.get('maxDiskUsage', 20971520), 'cpuLimit': spec.get('cpuLimit', 60),
            'memoryThresholdKB': spec.get('memoryKB', 196608), 'priority': 'PRIO_LOW',
            'visibility': 'FOREGROUND', 'latencyClass': 'FOREGROUND', 'loggingId': spec['loggingId'],
            'userLoginRequired': False, 'backgroundPriority': 200, 'someipManifest': 'manifest.json',
        },
    }
    if hmi == 'ID8':
        pkg['mguHmi'] = ['ID8']
    if spec.get('startType'):   # mgu-deploy: "autostart" starts with the platform and is never stopped for being hidden
        pkg['mguAppStartType'] = spec['startType']
    json.dump(pkg, open(os.path.join(src, 'package.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    json.dump(manifest, open(os.path.join(src, 'manifest.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    shutil.copy(os.path.join(KIT, 'platform', 'permissions.json'), os.path.join(src, 'permissions.json'))
    json.dump({'name': app_id, 'version': ver, 'lockfileVersion': 1}, open(os.path.join(src, 'npm-shrinkwrap.json'), 'w', encoding='utf-8', newline='\n'))
    # the SDK merges this over its own config. Newer SDKs (27.x, extracted from a newer donor app) build the app's
    # screens and entry point only with these on, and some donors ship them off: the app then has no screens and
    # crashed (issue #39). Older SDKs (24.x) ignore them.
    json.dump({'rhmiLoadingEnabled': True, 'entryPointLoadingEnabled': True, 'settings': {app_id: spec.get('config', {})}},
              open(os.path.join(src, 'config', 'base.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    # app code
    adir = os.path.join(APPS, src_id)
    fetch_assets(adir, spec.get('assets', []))
    for f in os.listdir(adir):
        if f.endswith('.js'):
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', 'app.js' if f == 'main.js' else f))
        elif f.endswith(('.wasm', '.wad')) or f in ('LICENSE', 'NOTICE'):
            # files the app reads as they are (doom: the game as WebAssembly, its data, its licences)
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
        elif os.path.isdir(os.path.join(adir, f)):
            # data folders go along as one compressed file, read with kit/runtime/pack.js
            # (e.g. dtc_scanner/dtc_db, the fault text database -> dtc_db.pack)
            raw, size, _ = pack_data.pack(os.path.join(adir, f), os.path.join(src, 'javascript', f + '.pack'))
            print('  %s/: %.1f MB packed to %.2f MB' % (f, raw / 1e6, size / 1e6))
        elif f.endswith('.pack') and not os.path.isdir(os.path.join(adir, f[:-5])):
            # a committed pack (e.g. dtc_scanner/dtc_db.pack); a local folder of the same name replaces it
            shutil.copy(os.path.join(adir, f), os.path.join(src, 'javascript', f))
            print('  %s (committed)' % f)
    # kit runtime
    if app_id == 'dtc_scanner' and language in ('zh-CN', 'ru'):
        module = 'build_diagnostic_zh' if language == 'zh-CN' else 'build_diagnostic_ru'
        catalog = __import__(module).catalog
        with tempfile.TemporaryDirectory(prefix='mgu-diagnostic-') as temporary:
            data = os.path.join(temporary, language + '.json')
            with open(data, 'w', encoding='utf-8', newline='\n') as file:
                json.dump(catalog(), file, ensure_ascii=False, separators=(',', ':'))
            pack_data.pack(temporary, os.path.join(src, 'javascript', 'diagnostic_i18n.pack'))
    kr = os.path.join(KIT, 'runtime')
    for f in os.listdir(kr):
        p = os.path.join(kr, f)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(src, 'javascript', 'kit', f))
        else:
            shutil.copy(p, os.path.join(src, 'javascript', 'kit', f))
    if language != 'ru':
        for name in ('ru.json', 'ru.tsv'):
            p = os.path.join(src, 'javascript', 'kit', 'locales', name)
            if os.path.exists(p):
                os.remove(p)
    if language == 'ru':
        shutil.copy(os.path.join(KIT, 'localization', 'fonts', 'cyrillic-ru.json'),
                    os.path.join(src, 'javascript', 'kit', 'fonts', 'cyrillic.json'))
    if language == 'zh-CN':
        # Diagnostic glyphs are Chinese-only; keep the English runtime atlas intact.
        if app_id == 'dtc_scanner':
            shutil.copy(os.path.join(KIT, 'localization', 'fonts', 'diagnostic-zh-CN.json'),
                        os.path.join(src, 'javascript', 'kit', 'fonts', 'cjk.json'))
    if credit(language):
        # The translation credit in the installed entry code, as plain comments.
        entry = os.path.join(src, 'javascript', 'app.js')
        comment = ''.join('// %s\n' % line for line in credit(language)['comment'])
        with open(entry, 'rb') as file:
            body = file.read()
        with open(entry, 'wb') as file:
            file.write(comment.encode('utf-8') + body)
    rt_spec = {k: spec.get(k) for k in ('id', 'title', 'version', 'screens', 'popups', 'settings', 'config', 'startWidget')}
    rt_spec['stateIds'] = state_ids
    if hmi == 'ID8':
        rt_spec['hmi'] = 'ID8'          # the kit's iDrive 8 profile (display.js, mgu.js)
    json.dump(rt_spec, open(os.path.join(src, 'javascript', 'kit', 'app-spec.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    locale = {'language': language, 'strings': load_locale(language)}
    if credit(language):
        locale['credit'] = credit(language)['corner']
    json.dump(locale, open(os.path.join(src, 'javascript', 'kit', 'locale.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    shutil.copy(os.path.join(SDK, 'index.js'), os.path.join(src, 'node_modules', 'oap-sdk', 'index.js'))
    shutil.copy(os.path.join(SDK, 'package.json'), os.path.join(src, 'node_modules', 'oap-sdk', 'package.json'))

    # --- rhmiData: package format (inside source/) and installed format ---
    icon = spec['id'] + '_icon.png'
    app_json = {
        'schemaVersion': '1.3.0',
        'application': {
            'uuid': u(app_id, 'app'), 'type': 'OnlineApp', 'name': app_id, 'vendor': spec.get('vendor', 'custom'),
            'version': ver, 'defaultLanguage': 'en_GB',
            'stringBundleUuid': u(app_id, 'strings'), 'resourceBundleUuid': u(app_id, 'resources'),
            'entryPoints': [{
                'name': app_id.upper() + '_ENTRY', 'uuid': u(app_id, 'entry'), 'textId': sid(app_id, 'TITLE'),
                'icon': icon, 'insertionStateId': 20974, 'insertionFocusId': 2, 'insertionMode': 'INSERT_BELOW',
                'insertionOrder': 0, 'insertionPriority': 0, 'previewType': 'NONE', 'bookmarkable': True,
                'private': False, 'appearance': 'DEFAULT', 'isGroupHeader': False, 'insertionGroup': 0,
            }],
        },
    }
    if hmi == 'ID8':
        # the tile as IterioDev's car-tested iDrive 8 apps insert it: under the app's own first state
        ep = app_json['application']['entryPoints'][0]
        ep.update({'insertionStateId': min(state_ids.values()), 'insertionFocusId': 0, 'insertionMode': 0, 'availability': 'ENABLED'})
        for k in ('name', 'previewType', 'bookmarkable', 'private'):
            ep.pop(k, None)
    pr = os.path.join(src, 'rhmiData')
    os.makedirs(os.path.join(pr, 'uiDescriptions', hmi))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'texts'))
    os.makedirs(os.path.join(pr, 'variantGroups', 'Common', 'images'))
    pj = json.loads(json.dumps(app_json))
    pj['application']['uiDescriptions'] = [{'applicationFilePath': './uiDescriptions/%s/application.xml' % hmi,
                                            'uiDescriptionFilePath': './uiDescriptions/%s/uiDescription.json' % hmi, 'hmi': [hmi]}]
    pj['application']['variantGroups'] = [{'stringsPath': './variantGroups/Common/texts',
                                           'resourcesPath': './variantGroups/Common/images', 'hmi': [hmi], 'brands': ['BMW']}]
    json.dump(pj, open(os.path.join(pr, 'application.json'), 'w', encoding='utf-8', newline='\n'), indent=2)
    open(os.path.join(pr, 'uiDescriptions', hmi, 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    json.dump(uidesc, open(os.path.join(pr, 'uiDescriptions', hmi, 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
        json.dump(strings, open(os.path.join(pr, 'variantGroups', 'Common', 'texts', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    make_icon(spec, os.path.join(pr, 'variantGroups', 'Common', 'images', icon))

    ir = os.path.join(stage, 'rhmiData')
    os.makedirs(os.path.join(ir, 'uiDescription'))
    os.makedirs(os.path.join(ir, 'strings'))
    os.makedirs(os.path.join(ir, 'resources'))
    ij = json.loads(json.dumps(app_json))
    ij['application'].update({
        'entryPointsStringBundleUuid': u(app_id, 'ep-strings'), 'entryPointsResourceBundleUuid': u(app_id, 'ep-resources'),
        'externalDialogStringBundleUuid': u(app_id, 'ed-strings'),
        'bookmarkUuidPool': [u(app_id, 'bookmarks'), 1, 2, 3, 4, 5, 6, 7],
    })
    json.dump(ij, open(os.path.join(ir, 'application.json'), 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
    open(os.path.join(ir, 'uiDescription', 'application.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    json.dump(uidesc, open(os.path.join(ir, 'uiDescription', 'uiDescription.json'), 'w', encoding='utf-8', newline='\n'), indent=1)
    for lang in LANGS:
        json.dump(strings, open(os.path.join(ir, 'strings', lang + '.json'), 'w', encoding='utf-8', newline='\n'), ensure_ascii=False)
    shutil.copy(os.path.join(pr, 'variantGroups', 'Common', 'images', icon), os.path.join(ir, 'resources', icon))
    if spec.get('startWidget'):
        info = build_start_widget(spec, app_id, os.path.join(ir, 'resources', icon), os.path.join(stage, 'rhmiDataStartWidget'))
        print('  home-screen widget: %s (%s)' % (info['component'], info['layout']))

    # --- installer helpers + metadata ---
    shutil.copytree(os.path.join(KIT, 'tools', 'oapgen'), os.path.join(stage, 'oapgen'))
    meta = {'id': app_id, 'version': ver, 'title': spec['title'], 'native': NATIVE, 'kit': 1}
    # app.json signals with "_optional": "<what the app loses>": a unit without that interface
    # still installs the app, without it (deploy/mgu-app-install.sh says what is missing)
    optional = {i: f['_optional'] for i, f in spec.get('signals', {}).items() if isinstance(f, dict) and f.get('_optional')}
    if optional:
        meta['optional'] = optional
    json.dump(meta, open(os.path.join(stage, 'meta.json'), 'w', encoding='utf-8', newline='\n'), indent=1)

    # --- archives ---
    os.makedirs(DIST, exist_ok=True)
    if hmi == 'ID8':
        # iDrive 8: the source package only. The .mgu / npm packages of this stage would install there and never start:
        # the MGU Store's deploy tool gives them no oap-sdk on iDrive 8 (source_package_id8). The stage itself
        # (dist/<id>/) stays for the tools that run the app on a computer.
        for stale in (f'{app_id}@{ver}.mgu', f'{app_id}@{ver}.tgz'):
            if os.path.exists(os.path.join(DIST, stale)):
                os.remove(os.path.join(DIST, stale))
        archive, n = source_package_id8(spec, stage, pkg)
        print(f'{app_id} {ver}: {os.path.relpath(archive, ROOT)} ({os.path.getsize(archive) // 1024} KiB, a source package of {n} files, '
              f'built on the head unit), {len(uidesc["containers"])} screens, states {state_ids}')
        return
    bundle = os.path.join(DIST, f'{app_id}@{ver}.mgu')
    with gz_header_free(bundle) as gz, tarfile.open(fileobj=gz, mode='w') as tf:
        for n in ('meta.json', 'source', 'rhmiData', 'rhmiDataStartWidget', 'oapgen'):
            if os.path.exists(os.path.join(stage, n)):
                tf.add(os.path.join(stage, n), arcname=n)
    npm = os.path.join(DIST, f'{app_id}@{ver}.tgz')
    with gz_header_free(npm) as gz, tarfile.open(fileobj=gz, mode='w') as tf:
        tf.add(src, arcname='package')
    print(f'{app_id} {ver}: {os.path.relpath(bundle, ROOT)} ({os.path.getsize(bundle) // 1024} KiB), '
          f'{len(uidesc["containers"])} screens, states {state_ids}')


def gz_header_free(path):
    """A gzip stream whose header carries no clock time (mtime 0). The header holds 32 bits, so on a
    head unit whose clock is past 2106 (a car once showed 2179) every build failed.
    Use: with gz_header_free(p) as gz, tarfile.open(fileobj=gz, mode='w') as tf"""
    return gzip.GzipFile(path, 'wb', mtime=0)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', choices=languages(), default='en')
    parser.add_argument('--hmi', choices=['ID7', 'ID8'], default='ID7',
                        help='head unit: ID7 (iDrive 7, default) or ID8 (iDrive 8: the id app.json "id8" names)')
    parser.add_argument('apps', nargs='*')
    args = parser.parse_args()
    ids = args.apps or sorted(d for d in os.listdir(APPS) if os.path.exists(os.path.join(APPS, d, 'app.json')))
    for i in ids:
        build(i, args.language, args.hmi)


if __name__ == '__main__':
    main()
