/**
 * The appearance wave's font dropdown (2026-09-26): the pure row-set
 * (fontMenuResults — the DEFAULT row is a fuzzy candidate, so Enter can
 * never pick a row that isn't on screen), the pick composer (null = the
 * factory Libron — Source Sans 3 until 2026-10-26), the curated dev-browser
 * fallback roster, the FontMenuList SSR shape, and the reading-ink factory
 * ruling (globals.css no longer ships #ee928c/#6fa9d6; since the
 * bold-contrast round the unset bold ink is WHITE over the softer body
 * grey, and italic follows the text around it).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { FontMenuList, customFamilyFor, fontMenuResults } from "../components/settings/model-menu";
import {
	CURATED_FALLBACK_FONTS,
	DEFAULT_READING_FONT,
	AppearanceSection,
	composeFontFamily,
} from "../components/settings/appearance-section";

describe("fontMenuResults — the DEFAULT row is a candidate, never a ghost pick", () => {
	const families = ["Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"];

	it("empty query → the DEFAULT row first, then every family", () => {
		assert.deepEqual(fontMenuResults("", families), [null, "Arial", "CMU Serif", "Georgia", "Helvetica Neue", "Menlo"]);
	});

	it("the default row matches its own identity (libron/default), not everything", () => {
		assert.deepEqual(fontMenuResults("georgia", families), ["Georgia"]);
		assert.deepEqual(fontMenuResults("menlo", families), ["Menlo"]);
		// the default row is reachable by search…
		assert.deepEqual(fontMenuResults("libron", families)[0], null);
		// …and the retired factory family no longer summons it
		assert.ok(!fontMenuResults("source", families).includes(null));
		assert.ok(fontMenuResults("default", families).includes(null));
		// …and drops out of unrelated queries
		assert.ok(!fontMenuResults("georgia", families).includes(null));
	});

	it("a query matching nothing yields an empty list (the custom input is the escape)", () => {
		assert.deepEqual(fontMenuResults("zzzz", families), []);
	});
});

describe("composeFontFamily — null/blank = the factory family, otherwise verbatim", () => {
	it("null → fontFamily null (the factory-family semantics preserved)", () => {
		assert.equal(composeFontFamily({ background: "#101010" }, null).fontFamily, null);
	});
	it("blank/whitespace → null too", () => {
		assert.equal(composeFontFamily(undefined, "  ").fontFamily, null);
	});
	it("a family commits verbatim (trimmed)", () => {
		assert.equal(composeFontFamily(undefined, " Georgia ").fontFamily, "Georgia");
	});
	it("the rest of the section rides along", () => {
		const next = composeFontFamily({ background: "#101010" }, "Menlo");
		assert.equal(next.background, "#101010");
	});
});

describe("the curated dev-browser fallback", () => {
	it("is the app's knowns + ubiquitous macOS families — and never a fabricated system list member for the factory family", () => {
		assert.ok(CURATED_FALLBACK_FONTS.includes("CMU Serif"));
		assert.ok(CURATED_FALLBACK_FONTS.includes("Georgia"));
		// the factory family lives ONLY as the DEFAULT row — never a
		// duplicated family row
		assert.ok(!CURATED_FALLBACK_FONTS.includes(DEFAULT_READING_FONT));
	});
});

describe("FontMenuList (thin SSR)", () => {
	it("renders the DEFAULT row, the families, and the custom escape", () => {
		const html = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily={null} onPick={() => {}} />,
		);
		assert.ok(html.includes('data-testid="font-option-default"'), "the default row");
		assert.ok(html.includes("default</span>"), "the default row carries its mark");
		assert.ok(html.includes('data-testid="font-option-Georgia"'), "a family row");
		assert.ok(html.includes('data-testid="font-option-Menlo"'), "another family row");
		assert.ok(html.includes('data-testid="font-search"'), "the search field");
		// ONE field (owner ask 2026-09-26: "why two?") — the custom-family
		// input is gone; the search field absorbed its job via the
		// "Use '<query>'" action row.
		assert.ok(!html.includes('data-testid="font-custom-input"'), "no separate custom input");
		assert.ok(!html.includes('data-testid="font-custom-set"'), "no Set button");
		assert.ok(!html.includes("Type a family name"), "no second field placeholder");
		assert.ok(html.includes("Search fonts…"), "the search placeholder");
	});

	it("the effective family's row carries the quiet highlight; the default row does when unset", () => {
		const unset = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily={null} onPick={() => {}} />,
		);
		const defaultRow = unset.split('data-testid="font-option-default"')[1]?.split("</button>")[0] ?? "";
		assert.ok(defaultRow.includes("bg-muted/60"), "unset → the default row is the effective one");

		const menlo = renderToStaticMarkup(
			<FontMenuList families={["Georgia", "Menlo"]} effectiveFamily="Menlo" onPick={() => {}} />,
		);
		const menloRow = menlo.split('data-testid="font-option-Menlo"')[1]?.split("</button>")[0] ?? "";
		const georgiaRow = menlo.split('data-testid="font-option-Georgia"')[1]?.split("</button>")[0] ?? "";
		assert.ok(menloRow.includes("bg-muted/60"), "the stored family highlights");
		assert.ok(!georgiaRow.includes("bg-muted/60"), "others do not");
	});

	it("undefined families = the enumerating state (Loading fonts…), not an empty picker", () => {
		const html = renderToStaticMarkup(
			<FontMenuList families={undefined} effectiveFamily={null} onPick={() => {}} />,
		);
		assert.ok(html.includes("Loading fonts…"));
	});
});

describe("the appearance section's font control (thin SSR)", () => {
	it("the reading-font row renders the dropdown TRIGGER — the old free-text input is gone", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={undefined} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes('data-testid="font-trigger"'), "the trigger");
		assert.ok(html.includes(DEFAULT_READING_FONT), "unset shows the factory family");
		assert.ok(html.includes('aria-expanded="false"'), "the collapsed state");
		// the old CommitInput is retired
		assert.ok(!html.includes('data-testid="input-font"'));
		assert.ok(!html.includes('placeholder="Source Sans 3"'));
		assert.ok(!html.includes("Source Sans 3"), "the retired factory family is gone from the section");
	});

	it("a stored family shows in the trigger (the record never lies)", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={{ fontFamily: "Georgia" }} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes("Georgia"));
	});
});

describe("the reading-ink factory ruling (globals.css, bold-contrast round 2026-10-26)", () => {
	it("the old emphasis hexes are GONE from the ink token declarations", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		assert.ok(!css.includes("--lh-ink-strong: #ee928c"), "bold factory is not the old orange");
		assert.ok(!css.includes("--lh-ink-italic: #6fa9d6"), "italic factory is not the old blue");
	});

	it("both blocks: body grey, bold WHITE, italic follows the surrounding text", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		assert.equal((css.match(/--lh-ink-body: #b4b4b4;/g) ?? []).length, 2, "both theme blocks");
		assert.equal((css.match(/--lh-ink-strong: #ffffff;/g) ?? []).length, 2, "both theme blocks");
		assert.equal((css.match(/--lh-ink-italic: currentColor;/g) ?? []).length, 2, "both theme blocks");
		assert.ok(!css.includes("--lh-ink-strong: var(--foreground)"), "the same-as-text ruling is superseded");
	});

	it("the reading surfaces take the body grey through .lh-reading, never through .lh-prose itself", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		assert.match(css, /\.lh-reading \{\s*color: var\(--lh-ink-body\);\s*\}/, "the container rule");
		const prose = /\.lh-prose \{([^}]*)\}/.exec(css)?.[1] ?? "";
		assert.ok(!/\bcolor:/.test(prose), ".lh-prose sets no color — muted surfaces keep their own grey");
	});

	it("markdown headings take the bold ink (a heading never dims below the bold under it)", () => {
		const css = fs.readFileSync("app/globals.css", "utf-8");
		const headings = /\.lh-prose :where\(h1, h2, h3, h4, h5, h6\) \{([^}]*)\}/.exec(css)?.[1] ?? "";
		assert.ok(headings.includes("color: var(--lh-ink-strong)"), headings);
	});

	it("the appearance rows' empty-state labels: bold 'white', italic 'same as text'", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={undefined} onSectionChange={() => {}} />,
		);
		assert.equal((html.match(/Empty = white/g) ?? []).length, 1, "the bold row");
		assert.equal((html.match(/Empty = same as text/g) ?? []).length, 1, "the italic row");
		assert.ok(!html.includes("#ee928c"));
		assert.ok(!html.includes("#6fa9d6"));
	});
});

describe("Libron — the bundled reading font (owner ruling 2026-10-26)", () => {
	const css = fs.readFileSync("app/globals.css", "utf-8");

	it("ships four static faces from public/fonts/libron, OFL alongside", () => {
		for (const face of ["Regular", "Italic", "Bold", "BoldItalic"]) {
			assert.ok(fs.existsSync(`public/fonts/libron/Libron-${face}.woff2`), `Libron-${face}.woff2 is bundled`);
			assert.ok(css.includes(`url("/fonts/libron/Libron-${face}.woff2") format("woff2")`), `@font-face for ${face}`);
		}
		assert.ok(fs.existsSync("public/fonts/libron/OFL.txt"), "the license rides with the files");
		assert.equal((css.match(/font-family: "Libron";/g) ?? []).length, 4, "one @font-face per face");
	});

	it("the prose token reads Libron; Source Sans 3 and its next/font variable are retired", () => {
		assert.match(css, /--font-prose: "Libron", Georgia, "Times New Roman", serif;/);
		assert.match(css, /--font-sans: "Libron", Georgia, "Times New Roman", serif;/, "the Tailwind alias follows");
		assert.ok(!css.includes("--font-sans3"), "no Source Sans 3 variable anywhere in the stylesheet");
		const layout = fs.readFileSync("app/layout.tsx", "utf-8");
		assert.ok(!layout.includes("Source_Sans_3"), "the Google Fonts download is gone");
	});

	it("titles follow the reading font by default; CMU Serif stays bundled as the opt-in", () => {
		assert.match(css, /--font-title: var\(--font-prose\);/);
		assert.ok(css.includes('font-family: "lh-cmu";'), "the CMU face is still declared");
		assert.ok(fs.existsSync("public/fonts/cmunbx.ttf"));
	});

	it("the factory reading family is Libron", () => {
		assert.equal(DEFAULT_READING_FONT, "Libron");
	});
});

describe("customFamilyFor — the single-field custom escape (2026-09-26)", () => {
	const families = ["Arial", "CMU Serif", "Georgia", "Menlo"];

	it("a query matching nothing becomes the custom pick", () => {
		assert.equal(customFamilyFor("Baskerville", families), "Baskerville");
		assert.equal(customFamilyFor("  zzz  ", families), "zzz");
	});

	it("a matching family is the better pick — no action row", () => {
		assert.equal(customFamilyFor("georgia", families), null);
		// the default row matches too — "libron"/"default" queries pick it
		assert.equal(customFamilyFor("libron", families), null);
	});

	it("an empty query is never a custom pick", () => {
		assert.equal(customFamilyFor("", families), null);
		assert.equal(customFamilyFor("   ", families), null);
	});
});
