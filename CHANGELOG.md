# Changelog

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
