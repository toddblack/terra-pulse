# Terra Pulse — Privacy Policy

*Last updated: 19 October 2026*

Terra Pulse is a desktop app for exploring earthquakes alongside solar,
geomagnetic and astronomical data. It is built by Todd Black and runs entirely
on your computer.

## The short version

- **No account, no sign-in, no tracking.** Terra Pulse has no analytics, no
  telemetry, no advertising and no crash reporting. Nothing about you or how
  you use the app is sent to the developer.
- **Your data stays on your computer.** Everything the app downloads and
  everything you set — including a location you choose to watch — is stored
  locally and nowhere else.
- **It does fetch public science data from the internet.** Like any request
  your computer makes, those reach the servers listed below, which see your IP
  address.

## What the app stores, and where

On your own computer only, in the app's data folder:

- the scientific data it downloads (earthquake catalogues, space-weather
  records, and similar), in a local database;
- your settings, such as which layers are shown, the window's size, and
  whether to check for updates;
- **a location you choose to watch** for earthquake alerts ("Watch this spot"),
  if you set one. It is used on your computer to decide when to alert you and
  to choose nearby seismic stations; it is never sent to the developer.

Uninstalling the Microsoft Store version removes this data folder. You can
also delete it yourself at any time.

## What the app sends over the internet

Terra Pulse downloads public scientific data directly from the organisations
that publish it. Each request goes straight from your computer to that
organisation's server — never through a server run by the developer — and,
as with any web request, that server can see your **IP address** and the
app's name and version. Their own privacy policies govern what they do with
it.

The sources, by kind:

- **Earthquakes:** the U.S. Geological Survey, and the European-Mediterranean
  Seismological Centre.
- **Live seismic waveforms and station information:** EarthScope (IRIS),
  GeoNet (New Zealand), GFZ Potsdam (GEOFON), and other public seismic
  networks in Europe and South America — only while you are viewing waveforms,
  replaying a quake, or watching a spot.
- **Space weather:** NOAA's Space Weather Prediction Center, NASA, and GFZ
  Potsdam.
- **Map imagery:** NASA GIBS, OpenStreetMap, and GEBCO.
- **Other reference data, on request:** the Global CMT project, the Nevada
  Geodetic Laboratory (GPS), and NASA JPL (planetary positions).
- **Update check (GitHub download only):** once a day, the version downloaded
  from GitHub asks GitHub whether a newer release exists. You can turn this off
  in the panel behind the version number in the lower-right corner. The
  Microsoft Store version never makes this request; the Store handles its
  updates.

A location you watch is used to choose which nearby stations to stream; the
requests ask those networks for named stations, not for "data near this
point".

The complete list of sources, with their licences, is in
[SOURCES.md](SOURCES.md).

## Children

Terra Pulse is a general-audience science app. It does not knowingly collect
any information from anyone, children included.

## Changes

If this policy changes, the new version will be published here with a new
date.

## Contact

Questions about this policy: open an issue at
<https://github.com/toddblack/terra-pulse/issues>.
