import assert from "node:assert/strict";
import {
  LOCAL_OUTLETS,
  NATIONAL_OUTLETS,
  NEWS_DEFAULT_POLL_SEC,
  NEWS_MIN_POLL_SEC,
  googleNewsUrl,
  isAllowedNewsUrl,
  matchLocalOutlets,
  mergeStories,
  parseNewsXml,
  placeQuery,
  pollIntervalSec,
  remainingMaxAge,
  resolveNewsFeeds,
  newsSaveError,
  selectedNationalIds,
} from "./news.ts";

const ids = new Set<string>();
for (const outlet of [...NATIONAL_OUTLETS, ...LOCAL_OUTLETS]) {
  assert.equal(ids.has(outlet.id), false, outlet.id);
  ids.add(outlet.id);
  assert.equal(outlet.url.startsWith("https://"), true, outlet.url);
  assert.equal(isAllowedNewsUrl(outlet.url), true, outlet.url);
}
assert.equal(ids.has("google.local"), false);

const pennHills = matchLocalOutlets(40.4759, -79.833);
assert.deepEqual(
  pennHills.map((outlet) => outlet.id),
  ["publicsource", "trib", "wesa"],
);
assert.equal(pennHills.some((outlet) => outlet.id === "inquirer"), false);
assert.ok(pennHills[0].distanceMi < 15);

const milesCity = matchLocalOutlets(46.4083, -105.8406);
assert.equal(milesCity.length, 0);

assert.equal(
  placeQuery("Penn Hills, Allegheny County, Pennsylvania, United States"),
  "Penn Hills, Pennsylvania",
);
assert.equal(
  placeQuery("123 Main Street, Pittsburgh, Pennsylvania, United States"),
  "Pittsburgh, Pennsylvania",
);
assert.equal(placeQuery("40.44062, -79.99589"), null);
assert.equal(placeQuery("Houston"), "Houston");

const google = googleNewsUrl("Penn Hills, Pennsylvania");
assert.equal(
  google,
  "https://news.google.com/rss/search?q=Penn+Hills%2C+Pennsylvania&hl=en-US&gl=US&ceid=US%3Aen",
);
assert.equal(isAllowedNewsUrl(google), true);
assert.equal(isAllowedNewsUrl("https://news.google.com/rss?hl=en-US"), false);
assert.equal(isAllowedNewsUrl("https://example.com/rss"), false);

const place = {
  provider: "address",
  query: "Penn Hills",
  label: "Penn Hills, Allegheny County, Pennsylvania, United States",
  lat: 40.4759,
  lon: -79.833,
  confirmed: true,
};
const resolved = resolveNewsFeeds({ location: place, outlets: ["bbc", "nope", "npr", "npr"] });
assert.equal(resolved.ok, true);
if (resolved.ok) {
  assert.deepEqual(
    resolved.feeds.map((feed) => feed.id),
    ["bbc", "npr", "publicsource", "trib", "wesa"],
  );
}
assert.equal(selectedNationalIds({ outlets: "fox, nope, abc" }).join(","), "abc,fox");
assert.equal(newsSaveError({ outlets: [] }), "Pick at least one national outlet.");
assert.equal(newsSaveError({ outlets: ["npr"] }), null);
const missing = resolveNewsFeeds({
  location: place,
  outlets: [],
});
assert.equal(missing.ok, false);

const rural = resolveNewsFeeds({
  location: {
    confirmed: true,
    lat: 46.4083,
    lon: -105.8406,
    label: "Miles City, Montana, United States",
  },
  outlets: ["npr"],
});
assert.equal(rural.ok, true);
if (rural.ok) {
  assert.equal(rural.feeds[1].id, "google.local");
  assert.equal(rural.feeds[1].name, "Local headlines · Miles City, Montana");
  assert.equal(isAllowedNewsUrl(rural.feeds[1].url), true);
}

assert.equal(pollIntervalSec({ ttlMinutes: 15, maxAgeSec: 5 }), 15 * 60);
assert.equal(pollIntervalSec({ maxAgeSec: 60 }), 60);
assert.equal(pollIntervalSec({ maxAgeSec: 21 }), NEWS_MIN_POLL_SEC);
assert.equal(
  pollIntervalSec({ ttlMinutes: 1, updatePeriod: "hourly", updateFrequency: 1 }),
  60,
);
assert.equal(pollIntervalSec({ maxAgeSec: 421 }), 421);
assert.equal(pollIntervalSec({ ttlMinutes: 5, maxAgeSec: 300 }), 300);
assert.equal(
  pollIntervalSec({ updatePeriod: "hourly", updateFrequency: 1, maxAgeSec: 3600 }),
  3600,
);
assert.equal(pollIntervalSec({}), NEWS_DEFAULT_POLL_SEC);
assert.equal(pollIntervalSec({ maxAgeSec: remainingMaxAge(0, 0) }), NEWS_DEFAULT_POLL_SEC);
assert.equal(remainingMaxAge(300, 250), 50);

const rss = `<?xml version="1.0"?>
<rss version="2.0" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
  <channel>
    <title>Example</title>
    <ttl>15</ttl>
    <sy:updatePeriod>hourly</sy:updatePeriod>
    <sy:updateFrequency>2</sy:updateFrequency>
    <item>
      <title><![CDATA[Hello & world]]></title>
      <link>https://example.com/a</link>
      <guid>a</guid>
      <pubDate>Sat, 14 Nov 2026 00:12:43 -0500</pubDate>
      <description>&lt;p&gt;A &#8211; story about Penn Hills.&lt;/p&gt;</description>
    </item>
    <item>
      <title>AT&amp;T wins the night</title>
      <link>https://example.com/b</link>
      <pubDate>Fri, 13 Nov 2026 12:00:00 GMT</pubDate>
      <description>Short</description>
    </item>
  </channel>
</rss>`;
const parsed = parseNewsXml(rss);
assert.equal(parsed.ttlMinutes, 15);
assert.equal(parsed.updatePeriod, "hourly");
assert.equal(parsed.updateFrequency, 2);
assert.equal(parsed.items.length, 2);
assert.equal(parsed.items[0].title, "Hello & world");
assert.equal(parsed.items[0].summary, "A – story about Penn Hills.");
assert.equal(parsed.items[1].title, "AT&T wins the night");
assert.equal(parsed.items[1].summary, "Short");

const stories = mergeStories(
  [
    {
      feed: { id: "npr", name: "NPR", url: "https://example.com", scope: "national" },
      items: parsed.items,
    },
  ],
  40,
);
assert.equal(stories[0].title, "Hello & world");
assert.equal(stories[0].publishedAt, "2026-11-14T05:12:43.000Z");
assert.equal(stories[1].summary, undefined);
assert.equal(stories[0].url, "https://example.com/a");

const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom</title>
  <updated>2026-11-14T08:00:00Z</updated>
  <entry>
    <title>Atom story</title>
    <link href="https://example.com/atom" rel="alternate"/>
    <id>tag:example.com,2026:atom</id>
    <updated>2026-11-14T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Atom body with enough words to keep.&lt;/p&gt;</summary>
  </entry>
</feed>`;
const atomParsed = parseNewsXml(atom);
assert.equal(atomParsed.items.length, 1);
assert.equal(atomParsed.items[0].link, "https://example.com/atom");
assert.equal(atomParsed.items[0].summary, "Atom body with enough words to keep.");
assert.equal(atomParsed.ttlMinutes, null);

console.log("news.test.ts ok");
