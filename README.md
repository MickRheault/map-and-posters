# Map & Posters

A local desktop editor for turning GPX recordings, stops and photos into trip posters. Open **index.html** in a desktop browser. The standalone editor works offline. Its files and exports stay on your device.

1. Import one or more GPX files. Review recording order and possible overlaps.
2. Use the itinerary editor to set day boundaries, group recordings and insert rest days. Pick the matching pass when the route visits a place twice.
3. Add places and visits, select overnight stops, and assign photos. Use the poster studio to preview the full trip, individual days and combinations.
4. Download JPG or PNG images individually, or select a set for ZIP export.

The editor saves changes in the current browser using IndexedDB. Download a backup before clearing browser data or moving to another browser. The versioned JSON backup contains the original recordings, photos and editable project. A backup containing photos can be large.

## Development

Use Node 24, Bun 1.4.4, Python 3, and unzip. From a checkout:

```sh
npm ci
npm run check
```

Edit the TypeScript and HTML in `src/`. The build writes the standalone `index.html`; commit the compiled file with source changes. Installing dependencies enables the repository’s pre-push hook. It runs `npm run verify` in an isolated checkout of each outgoing commit, including the test suite, type check and a clean rebuild.

GitHub Actions runs the same verification for pull requests, main and version tags. Each successful run produces the standalone HTML as an artifact. Pushing a `v*` version tag publishes the verified HTML as a GitHub release asset.
