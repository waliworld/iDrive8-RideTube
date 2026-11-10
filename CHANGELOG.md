# Changelog

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
