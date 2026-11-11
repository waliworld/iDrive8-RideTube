# Changelog

## Service 0.4.3: iDrive 8, what plays for the apps there (diagnostics; the app stays 0.4.5)

The Diagnostics pages of 0.4.2 from a car: the MediaPlayer's `OapGenericMedia` (service 0xb042, instance 0x28) is not
offered, like every on-demand player (Dynamic*, Browser*, Alexa); only the connected devices' players answer. The
app manager (MainApp-21) has no description of the MediaPlayer at all: of the audio it has CommandControl and a
`DynamicMediaPlayer`. So on iDrive 8 a player is made on demand, through an interface nobody has documented. This
release reads what is needed to use it; it calls nothing new.

- *The dynamic media player*: its description (printed whole: methods, arguments, fields), its instances asked,
  its fields read.
- The code around it: the interface calls near `DynamicMediaPlayer` in the app manager's code, and pieces of the
  code around `DynamicMediaPlayer`, `playFile`, `OapGenericMedia` (the app manager's code is read first).
- *What runs the media*: the processes and systemd units of the media and the audio, the sound cards.
- The audio manager's sources and sinks, read through a description made of the unit's catalog (MainApp's own lacks
  the two lists); all of the MediaPlayer's instances are asked (0.4.2 stopped at 32); the catalog's audio
  interfaces are listed in full. The page is shorter where it was long (instances counted, players summed up).

## Service 0.4.2: iDrive 8, "Service unavailable for call playFile()" (the app stays 0.4.5)

On a car, service 0.4.1 got the audio manager up and its `connect` accepted; the play then stopped at
`Service unavailable for call playFile() (the car's MediaPlayer "OapGenericMedia" is not available)`: this iDrive 8
has a description of the MediaPlayer, and does not offer (or does not let this service see) the instance iDrive 7
plays OAP media with.

- **The players the car does offer are asked.** When the player in use does not answer at the start (3 s), every
  instance of every description of the MediaPlayer on the unit (MainApp's, a numbered one, the apps' copies) is
  given a proxy and asked. Used instead: the same instance under another description (a numbered interface), else
  the only offered instance named like the generic OAP media player, with the audio source named like it. Nobody
  else's player (USB, Bluetooth) is tried. `audio.json`'s instance is never replaced. A play looks again, and goes
  back to the measured instance once the car offers it.
- **A player started with its source.** At a play, a player that does not answer is given 4 s once the source is
  connected, before `playFile`.
- **The error says it**: "the car does not offer the media player "OapGenericMedia" on this head unit (Settings >
  Diagnostics)".
- **Diagnostics, for the next step if none is offered**: the players asked and which answer; each interface's SOME/IP
  service and instance id; *Who may use them* - the unit's SOME/IP security policies (`/etc/vsomeip`: who may ask
  for and who offers the audio manager and the player, and whether this service is named); *How the installed apps
  play media* - the code of the installed apps and the app manager read once in the background (bounded) for the
  player instances, interfaces, playback calls and SDK media modules they use.

## App 0.4.5, service 0.4.1: iDrive 8, "Error: audio service timed out"

First run of the whole app on a car (0.4.4): it draws, touch, the keyboard, search and thumbnails work. A video
stops at "Error: audio service timed out": the service never got the car's audio up, and said so in a journal
nobody can read from the driver's seat.

- **The service says why.** The audio start is followed step by step (the SOME/IP binding, the audio manager's and
  the media player's descriptions, their proxies, the audio manager answering, its lists, leftover connections). A
  play that finds it not up ends with the reason ("the car's audio is not ready - the car's audio manager
  (CommandControl) does not answer"), not a timeout. A proxy that never starts no longer holds the start for good:
  each try is given 8 s, and the next one joins it.
- **Settings > Diagnostics** (the rail's Settings card): pages of text to read or photograph. The app's lines (its
  version, the renderer, the speed signal), then the service's, asked with the new `diag` command: where the audio
  start stopped and its last error; the descriptions found, the instance used of those each has, whether each
  answers; the route (source, sink, whether the car lists them); the car's sources, sinks and connections; the last
  play (what `connect` and `playFile` answered) and the player's last events; where the head unit keeps the
  descriptions (MainApp's folders, the installed apps' `someipInterfaces/`, the interface catalog, the app manager's
  generator, and a bounded search for them elsewhere when one is missing); the video decoder; the log's last lines.
- **It looks further for what iDrive 7 has in one place.** The two descriptions: MainApp's folders as before, then an
  installed app's `someipInterfaces/`, then a numbered name (`...mediaplayer2_MediaPlayer2.json`, as iDrive 8 numbers
  its HMI's interfaces), then made from the unit's interface catalog by the app manager's own generator. The
  instance: CommandControl's only one where it has no `1`; the player's only one named like the generic OAP media
  player where it has no `OapGenericMedia`. The sink: where 1024 is not on the unit, the only sink, or the only one
  the car's own connections use; among several nothing is picked. Each of these is logged and shown on the page.
  `state/audio.json` still wins. A head unit that has everything where iDrive 7 has it starts as before.
- A `connect` or `playFile` the binding rejects with something that is no Error says which call failed, and a
  player whose instance is not offered is named in the error.
- The kit has `textSheet` (pages of wrapped plain text). `kit/tools/test_node8.js` also checks the service.

Nobody has heard this play on an iDrive 8 yet: if a video still does not play, the Diagnostics pages are the report.

## App 0.4.4: iDrive 8, the page opened but the app's code did not load

First run past the tile on a car (0.4.3): the page opened and said "RideTube - did not load ... the kit was loaded
without the app's entry module". The start, the tile and the page work there; the hand-over of the SDK did not.

- The entry module gave the SDK to the kit through a global. On the car the linked bundle does not run with the
  `global` the package's other files see (the head unit's entry point loads the bundle its own way), so the kit,
  loaded one line later, found nothing. The SDK and the host now go through the kit's own module (`kit/sdk.js`
  `give`), which Node's module cache keeps one of. The test's stand-in for the car's entry point now runs the bundle
  in a JavaScript context of its own; the published 0.4.3 shows the car's exact message there.
- Nothing in the kit tells what an object from the entry module is with `instanceof` any more (a `Map` from the
  SDK's context is no instance of the kit's).
- **The renderer is spoken to as the iDrive 8 apps known to draw on a car speak to it** (IterioDev's dialect of
  mgu-render's protocol: the app id alone in HELLO, touch claims, pictures and videos by the same message numbers
  mgu-render/1 uses, a layer). 0.4.0 to 0.4.3 asked for mgu-render/1, where an app shows only while the renderer's
  foreground gate names it in front - a reading of the HMI nobody has confirmed on an iDrive 8, and one that
  hides the app if it finds nothing; a legacy connection is left as it is in that case. `MGU_RENDERD_PROTO=native`
  asks for mgu-render/1 on iDrive 8 again. iDrive 7 is unchanged.
- The renderer's status line says the dialect and whether touch areas are claimed.

## App 0.4.3: iDrive 8, the tile greys out and nothing opens - the app had no SDK

The cause of the report from the car (0.4.0 to 0.4.2): tapping RideTube's tile greys it out and nothing opens.

- The MGU Store's deploy tool gives an app BMW's oap-sdk in two ways. On iDrive 7 it generates the module
  `node_modules/oap-sdk` for a package that asks for it, which is how the original RideTube runs there. On iDrive 8
  it does not: there it only builds source packages (`mgu-app.json`), linking the modules they list against the
  oap-sdk of an app already on the car. RideTube for iDrive 8 was published as a package of the first kind. It
  installed, got its tile, and its process ended at the first line that loads the SDK, every time it was started.
  Reproduced with the deploy tool on its simulated iDrive 8 unit: the package queued for the car has no SDK in it.
- RideTube for iDrive 8 is now a source package, the kind the Store's own app is. One module is linked on the car,
  the kit's new entry module (`kit/id8/boot.js`); the kit and the app are plain files of the package and get the SDK
  from it (`kit/sdk.js`). The catalog lists it with `"build": "unit"`.
- The entry module does the start, the tile and the shutdown as the Store's app does them (its `store.js`,
  GPL-3.0-or-later, written again for the kit), and none of it waits for RideTube's own code or fails with it: if
  that code does not load or start, the page still opens and says what failed.
- iDrive 8 `permissions.json` names iDrive 8's interfaces (it had iDrive 7's); the app's log id is its own (`RTB8`).
- The page's first status line is the entry module's: version, start reason, tile, page, the app's code.
- Tests: `kit/tools/test_mgu8.js` builds the source package with the Store's own linker (the file its deploy tool
  runs on the car) and starts the result through its `main`, with no module named `oap-sdk` to be found;
  `kit/tools/test_node8.js` parses every file that ships as Node 8 does.
- 0.4.1's and 0.4.2's changes to how the screen follows the page stay, but they were not the cause.
- iDrive 7: as the original (the kit's start there is back to the original, with a listener for the SDK's `error`
  event).

## App 0.4.2: iDrive 8, the tile opens nothing / the page stays grey

Still reported from an iDrive 8 car: the tile is tapped, the screen goes grey, RideTube never shows. Not confirmed
on a car yet; each point below is a way the iDrive 8 start differed from the apps that are known to run there (the
MGU Store's app, IterioDev's apps), and each fails in the new tests on 0.4.1.

- The app said INACTIVE to the app manager once it took its page for hidden, and "HMI not visible" with every screen
  stack that did not name it. On iDrive 8 it now reports ACTIVE at the start and nothing else, as those apps do.
- A screen stack without `ROOT_APP` no longer hides the screen (0.4.1 still did). The page's own visible event
  decides; the stack only on an HMI that sends no visible events at all.
- The SDK's `error` event has a listener (without one Node ends the process), a focus event that is a bare value
  no longer throws, and an uncaught error is logged and shown instead of ending the app.
- The start goes on from the SDK's `initialized` event or `start()`, whichever comes first; the page is opened for
  the entry point the app was started with whatever the SDK calls the start reason, asked again after any refusal,
  and opened even when the mapping was refused.
- The tile keeps the manager's own name and icon (set from the app's bundles they go with the app's process, and
  the tile is left blank once the app stops). Each step of making it usable is tried on its own.
- The car's speed and battery are read through the SDK's typed proxies on iDrive 8, not the raw SOME/IP binding
  with iDrive 7's interface files; the manifest names those interfaces whole, as IterioDev's iDrive 8 apps do.
- **The page says what is wrong.** The HMI's own page under RideTube's screen now has four status lines (the
  version and how it was started, the page, the renderer, the service) and the reason in its title. While
  RideTube draws they are covered; when it does not, a photo of the screen says why.
- The string bundle is the page's own texts only (no dynamic slots).
- iDrive 7: unchanged but the `error` listener.

## App 0.4.1: iDrive 8 grey page

- iDrive 8: the page stayed grey (the HMI's empty page, RideTube's screen never drawn over it). The kit read the HMI's
  screen stack as on iDrive 7 (the page's numeric id in a list) and took any stack that did not list it that way
  for the page gone, so the renderer was told to hide RideTube right after it opened. On iDrive 8 the page's own
  visible event (true, 1 or "true") decides, as in the MGU Store's app and IterioDev's iDrive 8 apps; the stack
  only says the app is in front (ROOT_APP) or was left. The first HMI events go to the app's log.
- iDrive 8: when the screen still can't be drawn (no renderer, another app in front...), the page's title says why
  after 4 s instead of a silent grey page.
- Tests: kit/tools/test_mgu8.js starts the built app against a fake iDrive 8 HMI and a fake mgu-render.

## App 0.4.0, service 0.4.0: iDrive 8

- iDrive 8 (experimental, not yet run on a car): a second app, `jap_ridetube8` (`build.py --hmi ID8`), from the same
  code. The kit draws the whole screen on the app area of the 2880 x 960 display, with its own back button, an
  on-screen keyboard for Search (typing only while parked, recent searches as buttons), and the rail's Settings
  (account and settings). Touch only.
- Service: finds BMW's interface descriptions on iDrive 8 (`oap-mainapp21`), logs the audio manager's sources and
  sinks, takes another audio route from `state/audio.json`, says whether the head unit has the GPU decoder's Media
  SDK; `mguHmi` iDrive 7 and 8.
- The catalog has an entry per head unit; iDrive 8's does not require the controller gate (iDrive 7 only).
- iDrive 7: unchanged (the same package but the version).

## Service 0.3.9

- Videos play again: each video's folder was 0700, so BMW's media engine (its own uid) could not open the audio
  and the car answered `ITEM_UNPLAYABLE`. The folders are now 0711: the engine opens the audio by name, and
  nobody can list them. Folders cached by 0.3.8 are fixed when they are played.

## App 0.3.8

- Search: the menu opened from the rail's Search stays open. Before, the video page came back over it about a
  second later, because the head unit keeps that page listed under the menu. The kit now shows the page only
  while it is the screen of ours that came to the front last.

## App 0.3.7, service 0.3.8

- Video while driving takes effect only once switched on while the car is parked.
- The download stops when less than 256 MiB is left free on the head unit.
- README: data use, tested on, uninstall.

## App 0.3.6, service 0.3.7

First public release.
