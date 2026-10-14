const express = require("express");
const path = require("path");
const cheerio = require("cheerio");
const dns = require("dns").promises;
const http = require("http");
const https = require("https");
const net = require("net");

const app = express();
const PORT = 3000;
const MAX_HTML_BYTES = 1_000_000;
const MAX_STYLESHEET_BYTES = 150_000;
const MAX_STYLESHEETS = 6;
const MAX_STRUCTURE_NODES = 1200;
const MAX_STRUCTURE_DEPTH = 14;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function isPublicIPv4(ip) {
    const parts = ip.split(".").map(Number);
    const [a, b, c] = parts;

    if (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113)
    ) {
        return false;
    }

    return true;
}

function ipv6ToBigInt(ip) {
    let address = ip.toLowerCase();

    if (address.includes(".")) {
        const lastColon = address.lastIndexOf(":");
        const ipv4 = address.slice(lastColon + 1);

        if (!net.isIPv4(ipv4)) return null;

        const octets = ipv4.split(".").map(Number);
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        address = address.slice(0, lastColon) + ":" + high + ":" + low;
    }

    const halves = address.split("::");

    if (halves.length > 2) return null;

    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

    if (halves.length === 1 && left.length !== 8) return null;

    const groups = halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
        : left;

    if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) {
        return null;
    }

    return groups.reduce((value, group) => (value << 16n) | BigInt("0x" + group), 0n);
}

function isPublicIP(ip) {
    if (net.isIPv4(ip)) return isPublicIPv4(ip);
    if (!net.isIPv6(ip)) return false;

    const address = ipv6ToBigInt(ip);
    if (address === null) return false;

    const firstThreeBits = address >> 125n;
    const isGlobalUnicast = firstThreeBits === 1n;
    const isDocumentation = (address >> 96n) === 0x20010db8n;
    const isProtocolAssignment = (address >> 105n) === (0x2001n << 7n);
    const isSixToFour = (address >> 112n) === 0x2002n;

    return isGlobalUnicast && !isDocumentation && !isProtocolAssignment && !isSixToFour;
}

async function resolvePublicAddresses(url) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");

    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local")
    ) {
        throw new Error("Local websites cannot be analyzed.");
    }

    let addresses;

    if (net.isIP(hostname)) {
        addresses = [{ address: hostname }];
    } else {
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch {
            throw new Error("Could not find that website.");
        }
    }

    if (
        addresses.length === 0 ||
        addresses.some(item => !isPublicIP(item.address))
    ) {
        throw new Error("This website resolves to a restricted address.");
    }

    return { hostname, address: addresses[0].address };
}

async function validatePublicUrl(value) {
    let url;

    try {
        url = new URL(value);
    } catch {
        throw new Error("Enter a valid website URL.");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    const standardPort = url.protocol === "https:" ? "443" : "80";
    if (url.port && url.port !== standardPort) {
        throw new Error("Only standard HTTP and HTTPS ports are supported.");
    }

    if (url.username || url.password) {
        throw new Error("URLs containing login credentials are not allowed.");
    }

    const resolved = await resolvePublicAddresses(url);
    return { url, ...resolved };
}

function requestPinnedUrl(target, maxBytes) {
    return new Promise((resolve, reject) => {
        const transport = target.url.protocol === "https:" ? https : http;
        let settled = false;
        const totalTimeout = setTimeout(() => {
            const error = new Error("The website took too long to respond.");
            error.name = "TimeoutError";
            request.destroy(error);
        }, 12000);
        totalTimeout.unref();

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimeout);
            if (error) reject(error);
            else resolve(result);
        };

        const request = transport.request({
            protocol: target.url.protocol,
            hostname: target.hostname,
            port: target.url.port || undefined,
            path: target.url.pathname + target.url.search,
            method: "GET",
            agent: false,
            lookup: (_hostname, options, callback) => {
                if (options && options.all) {
                    callback(null, [{
                        address: target.address,
                        family: net.isIPv6(target.address) ? 6 : 4
                    }]);
                    return;
                }

                callback(
                    null,
                    target.address,
                    net.isIPv6(target.address) ? 6 : 4
                );
            },
            headers: {
                "User-Agent": "UIReverseEngineer/1.0",
                "Accept": "text/html,text/css;q=0.9,*/*;q=0.1"
            }
        }, response => {
            const statusCode = response.statusCode || 0;
            const contentType = response.headers["content-type"] || "";

            if ([301, 302, 303, 307, 308].includes(statusCode)) {
                response.destroy();
                finish(null, {
                    statusCode,
                    location: response.headers.location,
                    contentType
                });
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.destroy();
                finish(new Error("Website returned HTTP " + statusCode));
                return;
            }

            const declaredSize = Number(response.headers["content-length"] || 0);
            if (declaredSize > maxBytes) {
                response.destroy();
                finish(new Error("The resource is too large to analyze."));
                return;
            }

            const chunks = [];
            let total = 0;

            response.on("data", chunk => {
                total += chunk.length;

                if (total > maxBytes) {
                    const error = new Error("The resource is too large to analyze.");
                    finish(error);
                    response.destroy(error);
                    return;
                }

                chunks.push(chunk);
            });

            response.on("end", () => {
                finish(null, {
                    statusCode,
                    contentType,
                    body: Buffer.concat(chunks).toString("utf8")
                });
            });
            response.on("error", error => finish(error));
        });

        request.setTimeout(10000, () => {
            const error = new Error("The website took too long to respond.");
            error.name = "TimeoutError";
            request.destroy(error);
        });
        request.on("error", error => finish(error));
        request.end();
    });
}

async function fetchPublicResource(value, maxBytes, expectedType) {
    let target = await validatePublicUrl(value);

    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await requestPinnedUrl(target, maxBytes);

        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            if (!response.location || redirects === 3) {
                throw new Error("Too many or invalid redirects.");
            }

            let redirectedUrl;
            try {
                redirectedUrl = new URL(response.location, target.url).href;
            } catch {
                throw new Error("The website returned an invalid redirect.");
            }

            target = await validatePublicUrl(redirectedUrl);
            continue;
        }

        if (!response.contentType.toLowerCase().includes(expectedType)) {
            throw new Error("The resource did not return " + expectedType + ".");
        }

        return { body: response.body, url: target.url.href };
    }

    throw new Error("Could not retrieve the website.");
}

function extractDesignTokens(css) {
    const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const declarations = [...cleanCss.matchAll(/(?:^|[;{}])\s*(--[\w-]+|[a-z][\w-]*)\s*:\s*([^;{}]+)/gi)]
        .map(match => ({
            property: match[1].toLowerCase(),
            value: match[2].trim().replace(/\s*!important\s*$/i, "")
        }))
        .filter(item => item.value && item.value.length <= 180);

    const uniqueValues = (items, limit) => [
        ...new Set(items.filter(Boolean))
    ].slice(0, limit);
    const colorCandidates = cleanCss.match(
        /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\((?:[^()]|\([^()]*\))*\)/gi
    ) || [];
    const isValidColor = color => {
        if (color.startsWith("#")) {
            return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color);
        }

        const match = color.match(/^(rgba?|hsla?)\((.*)\)$/i);
        if (!match) return false;

        const name = match[1].toLowerCase();
        const parts = match[2].trim().split(/\s*\/\s*/);
        if (parts.length > 2) return false;

        const channels = parts[0].includes(",")
            ? parts[0].split(/\s*,\s*/)
            : parts[0].trim().split(/\s+/);
        let alpha = parts.length === 2 ? parts[1].trim() : null;

        if (channels.length === 4 && !alpha) {
            if (parts[0].includes(",")) {
                alpha = channels.pop();
            } else {
                return false;
            }
        }

        if (channels.length !== 3) return false;

        const alphaPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;
        if (alpha && !alphaPattern.test(alpha)) return false;

        if (name.startsWith("rgb")) {
            const channelPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)%?$/;
            return channels.every(channel => channelPattern.test(channel));
        }

        const huePattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:deg|rad|grad|turn)?$/i;
        const percentPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;
        return huePattern.test(channels[0]) &&
            percentPattern.test(channels[1]) &&
            percentPattern.test(channels[2]);
    };
    const colorToHex = color => {
        const hex = color.match(/^#([0-9a-f]+)$/i);
        if (hex) {
            let digits = hex[1];
            if (digits.length === 3 || digits.length === 4) {
                digits = [...digits].map(digit => digit + digit).join("");
            }
            return "#" + digits.slice(0, 6) +
                (digits.length === 8 && digits.slice(6) !== "ff" ? digits.slice(6) : "");
        }

        const match = color.match(/^(rgba?|hsla?)\((.*)\)$/i);
        const name = match[1].toLowerCase();
        const parts = match[2].trim().split(/\s*\/\s*/);
        const channels = parts[0].includes(",")
            ? parts[0].split(/\s*,\s*/)
            : parts[0].trim().split(/\s+/);
        let alpha = parts.length === 2 ? parts[1].trim() : null;

        if (channels.length === 4 && !alpha) alpha = channels.pop();

        const parseAlpha = value => value == null
            ? 1
            : value.endsWith("%")
                ? Number.parseFloat(value) / 100
                : Number.parseFloat(value);
        const toByte = value => Math.max(0, Math.min(255, Math.round(value)));
        let rgb;

        if (name.startsWith("rgb")) {
            rgb = channels.map(channel => {
                const number = Number.parseFloat(channel);
                return toByte(channel.endsWith("%") ? number * 255 / 100 : number);
            });
        } else {
            let hue = Number.parseFloat(channels[0]);
            if (channels[0].endsWith("turn")) hue *= 360;
            else if (channels[0].endsWith("rad")) hue *= 180 / Math.PI;
            else if (channels[0].endsWith("grad")) hue *= 0.9;
            hue = ((hue % 360) + 360) % 360;

            const saturation = Math.max(0, Math.min(1, Number.parseFloat(channels[1]) / 100));
            const lightness = Math.max(0, Math.min(1, Number.parseFloat(channels[2]) / 100));
            const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
            const segment = hue / 60;
            const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
            const components = segment < 1 ? [chroma, secondary, 0]
                : segment < 2 ? [secondary, chroma, 0]
                    : segment < 3 ? [0, chroma, secondary]
                        : segment < 4 ? [0, secondary, chroma]
                            : segment < 5 ? [secondary, 0, chroma]
                                : [chroma, 0, secondary];
            const offset = lightness - chroma / 2;
            rgb = components.map(component => toByte((component + offset) * 255));
        }

        const alphaByte = toByte(parseAlpha(alpha) * 255);
        const hexValue = rgb.map(channel => channel.toString(16).padStart(2, "0")).join("");
        return "#" + hexValue + (alphaByte < 255 ? alphaByte.toString(16).padStart(2, "0") : "");
    };
    const colors = uniqueValues(
        colorCandidates
            .map(color => color.trim().replace(/\s+/g, " ").toLowerCase())
            .filter(isValidColor)
            .map(colorToHex),
        40
    );

    const fonts = uniqueValues(
        declarations
            .filter(item => item.property === "font-family")
            .flatMap(item => item.value.split(/,(?![^()]*\))/))
            .map(font => font.trim().replace(/^['"]|['"]$/g, "")),
        20
    );

    const dimensionsFor = (properties, limit) => {
        const seen = new Set();
        const results = [];

        for (const item of declarations) {
            if (!properties.includes(item.property)) continue;

            const tokens = item.value.match(
                /var\(\s*--[\w-]+(?:\s*,\s*[^)]*)?\)|-?\d*\.?\d+(?:px|rem|em|vw|vh|vmin|vmax|%|ch|ex)\b/gi
            ) || [];

            for (const token of tokens) {
                const value = token.replace(/\s+/g, " ").toLowerCase();
                if (!seen.has(value)) {
                    seen.add(value);
                    results.push(value);
                    if (results.length >= limit) return results;
                }
            }
        }

        return results;
    };

    const shadows = uniqueValues(
        declarations
            .filter(item => ["box-shadow", "text-shadow"].includes(item.property))
            .map(item => item.property + ": " + item.value + ";"),
        15
    );
    const layoutProperties = [
        "display",
        "position",
        "grid-template-columns",
        "grid-template-rows",
        "flex-direction",
        "justify-content",
        "align-items"
    ];
    const layoutValues = {};

    for (const property of layoutProperties) {
        const values = uniqueValues(
            declarations
                .filter(item => item.property === property)
                .map(item => item.value),
            12
        );

        if (values.length) layoutValues[property] = values;
    }

    const radii = declarations
            .filter(item => item.property.includes("radius"))
            .map(item => ({
                property: item.property,
                value: item.value
            }));
    const seenRadii = new Set();
    const uniqueRadii = radii.filter(item => {
        const key = item.property + "\0" + item.value;
        if (seenRadii.has(key)) return false;
        seenRadii.add(key);
        return true;
    }).slice(0, 20);

    return {
        colors,
        fonts,
        fontSizes: uniqueValues(
            declarations
                .filter(item => item.property === "font-size")
                .map(item => item.value),
            25
        ),
        spacing: dimensionsFor(
            ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
                "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
                "gap", "row-gap", "column-gap"],
            30
        ),
        radii: uniqueRadii,
        shadows,
        layout: layoutValues
    };
}

async function fetchStylesheets($, pageUrl) {
    const stylesheetUrls = $("link[rel~='stylesheet'][href]")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter(Boolean)
        .slice(0, MAX_STYLESHEETS)
        .map(href => {
            try {
                const url = new URL(href, pageUrl);
                return ["http:", "https:"].includes(url.protocol) ? url.href : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);

    const results = [];
    let skipped = $("link[rel~='stylesheet'][href]").length - stylesheetUrls.length;

    for (let start = 0; start < stylesheetUrls.length; start += 3) {
        const batch = stylesheetUrls.slice(start, start + 3);
        const batchResults = await Promise.allSettled(
            batch.map(url => fetchPublicResource(url, MAX_STYLESHEET_BYTES, "text/css"))
        );

        for (const result of batchResults) {
            if (result.status === "fulfilled") results.push(result.value.body);
            else skipped++;
        }
    }

    return { css: results.join("\n"), analyzed: results.length, skipped };
}

app.post("/api/analyze", async function (req, res) {
    try {
        const input = req.body.url;

        if (typeof input !== "string" || input.length > 2048) {
            return res.status(400).json({
                error: "Please provide a valid website URL."
            });
        }

        const { body: html, url } = await fetchPublicResource(
            input,
            MAX_HTML_BYTES,
            "text/html"
        );
        const $ = cheerio.load(html);
        const title = $("title").first().text().trim() || "Untitled website";
        const description =
            $('meta[name="description"]').attr("content") || "No description found";
        const links = $("a[href]")
            .map((_, element) => $(element).attr("href"))
            .get();
        const embeddedCss = $("style")
            .map((_, element) => $(element).html() || "")
            .get()
            .join("\n");
        const inlineCss = $('[style]')
            .map((_, element) => $(element).attr("style") || "")
            .get()
            .join(";");
        const externalStylesheets = await fetchStylesheets($, url);
        const design = extractDesignTokens(
            embeddedCss + "\n" + externalStylesheets.css + "\n" + inlineCss
        );
        const stylesheetsAnalyzed = externalStylesheets.analyzed;
        const note = externalStylesheets.skipped
            ? `Analyzed embedded, inline, and ${stylesheetsAnalyzed} accessible external stylesheet(s). ${externalStylesheets.skipped} stylesheet(s) could not be analyzed. Dynamically generated styles may not be included.`
            : `Analyzed embedded, inline, and ${stylesheetsAnalyzed} external stylesheet(s). Dynamically generated styles may not be included.`;

        res.json({
            url,
            title,
            description,
            linkCount: links.length,
            links: links.slice(0, 100),
            ...design,
            stylesheetsAnalyzed,
            stylesheetsSkipped: externalStylesheets.skipped,
            note
        });
    } catch (error) {
        const message = error.name === "TimeoutError"
            ? "The website took too long to respond."
            : [
                "Enter a valid website URL.",
                "Only HTTP and HTTPS URLs are supported.",
                "Only standard HTTP and HTTPS ports are supported.",
                "URLs containing login credentials are not allowed.",
                "Local websites cannot be analyzed.",
                "Could not find that website.",
                "This website resolves to a restricted address.",
                "Too many or invalid redirects.",
                "The website returned an invalid redirect.",
                "The resource is too large to analyze.",
                "The resource did not return text/html.",
                "The website did not return text/html."
            ].includes(error.message)
                ? error.message
                : "Could not analyze this website. It may be inaccessible or block automated requests.";

        res.status(400).json({ error: message });
    }
});

app.post("/api/structure", async function (req, res) {
    try {
        const input = req.body.url;

        if (typeof input !== "string" || input.length > 2048) {
            return res.status(400).json({ error: "Please provide a valid website URL." });
        }

        const { body: html, url } = await fetchPublicResource(
            input,
            MAX_HTML_BYTES,
            "text/html"
        );
        const $ = cheerio.load(html);
        const root = $("html").first();
        const allowedAttributes = [
            "id", "class", "role", "href", "src", "alt", "type", "name",
            "aria-label", "title", "action", "method", "placeholder", "for",
            "target", "rel", "value"
        ];
        let nodeCount = 0;
        let truncated = false;

        const buildNode = (element, depth) => {
            if (nodeCount >= MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) {
                truncated = true;
                return null;
            }

            nodeCount++;
            const attributes = {};
            const rawAttributes = element.attribs || {};

            for (const name of allowedAttributes) {
                if (typeof rawAttributes[name] !== "string") continue;

                let value = rawAttributes[name].trim().slice(0, 200);
                if (["href", "src", "action"].includes(name) && value) {
                    try {
                        value = new URL(value, url).href.slice(0, 500);
                    } catch {
                        // Preserve malformed website-provided values as display-only text.
                    }
                }

                attributes[name] = value;
            }

            const directText = $(element)
                .contents()
                .filter(function () {
                    return this.type === "text";
                })
                .text()
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 300);
            const childElements = (element.children || [])
                .filter(child => child.type === "tag");
            const node = {
                id: nodeCount,
                tag: element.name,
                attributes,
                text: directText,
                childCount: childElements.length,
                children: []
            };

            if (depth < MAX_STRUCTURE_DEPTH) {
                for (const child of childElements) {
                    if (nodeCount >= MAX_STRUCTURE_NODES) {
                        truncated = true;
                        break;
                    }

                    const childNode = buildNode(child, depth + 1);
                    if (childNode) node.children.push(childNode);
                }
            } else if (childElements.length > 0) {
                truncated = true;
            }

            return node;
        };

        const tree = root.length
            ? buildNode(root.get(0), 0)
            : buildNode($.root().get(0), 0);

        res.json({
            url,
            title: $("title").first().text().trim() || "Untitled website",
            tree,
            nodeCount,
            truncated
        });
    } catch (error) {
        const message = error.name === "TimeoutError"
            ? "The website took too long to respond."
            : [
                "Enter a valid website URL.",
                "Only HTTP and HTTPS URLs are supported.",
                "Only standard HTTP and HTTPS ports are supported.",
                "URLs containing login credentials are not allowed.",
                "Local websites cannot be analyzed.",
                "Could not find that website.",
                "This website resolves to a restricted address.",
                "Too many or invalid redirects.",
                "The website returned an invalid redirect.",
                "The resource is too large to analyze.",
                "The resource did not return text/html."
            ].includes(error.message)
                ? error.message
                : "Could not inspect this website's structure. It may be inaccessible or block automated requests.";

        res.status(400).json({ error: message });
    }
});

app.use(function (error, req, res, next) {
    if (res.headersSent) return next(error);

    if (error.type === "entity.too.large") {
        return res.status(413).json({ error: "Request body is too large." });
    }

    if (error instanceof SyntaxError && error.status === 400) {
        return res.status(400).json({ error: "Please send valid JSON." });
    }

    console.error("Request failed:", error);
    return res.status(500).json({
        error: "The analyzer encountered an unexpected error."
    });
});

app.listen(PORT, function () {
    console.log("UI Reverse Engineer is running!");
    console.log("Open http://localhost:" + PORT);
});
