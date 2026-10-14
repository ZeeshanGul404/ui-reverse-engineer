const analyzeForm = document.getElementById("analyze-form");
const websiteUrl = document.getElementById("website-url");
const message = document.getElementById("message");
const analyzeButton = document.getElementById("analyze-button");
const structureFilter = document.getElementById("structure-filter");
let structureTreeData = null;
let selectedStructureNodeId = null;
let expandedStructureNodes = new Set();

function setEmptyState(container, text) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = text;
    container.replaceChildren(empty);
}

function createCopyButton(label, value, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "token-chip";
    button.textContent = label;
    button.dataset.copy = value;
    button.title = "Copy " + value;
    return button;
}

function renderTokens(containerId, values, toCss, emptyText, labelFor, className) {
    const container = document.getElementById(containerId);
    container.replaceChildren();

    if (!values.length) {
        setEmptyState(container, emptyText);
        return;
    }

    values.forEach(function (value, index) {
        const cssValue = toCss(value, index);
        container.appendChild(createCopyButton(
            labelFor ? labelFor(value) : value,
            cssValue,
            className || "token-chip"
        ));
    });
}

function renderColors(colors) {
    const palette = document.getElementById("color-palette");
    palette.replaceChildren();

    if (!colors.length) {
        setEmptyState(palette, "No colors found in the accessible styles.");
        return;
    }

    colors.forEach(function (color) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "color-swatch";
        button.dataset.copy = color;
        button.title = "Copy " + color;
        button.setAttribute("aria-label", "Copy color " + color);

        const swatch = document.createElement("span");
        swatch.className = "swatch-color";
        swatch.style.backgroundColor = color;

        const label = document.createElement("span");
        label.className = "swatch-label";
        label.textContent = color;

        const content = document.createElement("span");
        content.className = "swatch-content";
        content.append(swatch, label);
        button.appendChild(content);
        palette.appendChild(button);
    });
}

function renderTypography(data) {
    const fontList = document.getElementById("font-list");
    const fontSizeList = document.getElementById("font-size-list");
    fontList.replaceChildren();
    fontSizeList.replaceChildren();

    if (!data.fonts.length) {
        setEmptyState(fontList, "No font families found in the accessible styles.");
    } else {
        data.fonts.forEach(function (font) {
            const item = document.createElement("div");
            item.className = "font-family-card";

            const name = document.createElement("span");
            name.className = "font-family-name";
            name.textContent = font;
            name.style.fontFamily = font;

            const isCssValue = /^var\(/i.test(font);
            const cssFont = isCssValue || /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(font)
                ? font
                : JSON.stringify(font);
            const copy = createCopyButton(
                "Copy",
                "font-family: " + cssFont + ";",
                "token-chip font-copy-button"
            );
            item.append(name, copy);
            fontList.appendChild(item);
        });
    }

    if (!data.fontSizes.length) {
        setEmptyState(fontSizeList, "No font sizes found in the accessible styles.");
        return;
    }

    data.fontSizes.forEach(function (size) {
        fontSizeList.appendChild(createCopyButton(
            size,
            "font-size: " + size + ";",
            "token-chip"
        ));
    });
}

function renderRadii(radii) {
    const container = document.getElementById("radius-list");
    container.replaceChildren();

    if (!radii.length) {
        setEmptyState(container, "No border radius values found in the accessible styles.");
        return;
    }

    radii.forEach(function (radius) {
        const item = document.createElement("div");
        item.className = "radius-item";

        const property = document.createElement("span");
        property.className = "radius-property";
        property.textContent = radius.property;

        const value = createCopyButton(
            radius.value,
            radius.property + ": " + radius.value + ";",
            "token-chip radius-value"
        );

        item.append(property, value);
        container.appendChild(item);
    });
}

function renderLayout(groups) {
    const container = document.getElementById("layout-list");
    container.replaceChildren();

    const properties = Object.keys(groups);
    if (!properties.length) {
        setEmptyState(container, "No common layout declarations found in the accessible styles.");
        return;
    }

    properties.forEach(function (property) {
        const group = document.createElement("section");
        group.className = "layout-group";

        const heading = document.createElement("h3");
        heading.textContent = property;

        const values = document.createElement("div");
        values.className = "token-list layout-values";
        groups[property].forEach(function (value) {
            values.appendChild(createCopyButton(
                value,
                property + ": " + value + ";",
                "token-chip"
            ));
        });

        group.append(heading, values);
        container.appendChild(group);
    });
}

function getElementCategory(node, category) {
    const tag = node.tag.toLowerCase();
    const attributes = node.attributes;
    const inputType = (attributes.type || "").toLowerCase();

    if (category === "headings") return /^h[1-6]$/.test(tag);
    if (category === "links") return tag === "a" && Boolean(attributes.href);
    if (category === "buttons") {
        return tag === "button" ||
            (tag === "input" && ["button", "submit", "reset"].includes(inputType)) ||
            attributes.role === "button";
    }
    if (category === "images") return tag === "img";
    if (category === "forms") {
        return ["form", "input", "select", "textarea", "fieldset", "legend", "label", "button"]
            .includes(tag);
    }
    if (category === "semantic") {
        return ["html", "body", "header", "nav", "main", "section", "article", "aside",
            "footer", "address", "details", "summary", "figure", "figcaption", "time"]
            .includes(tag);
    }

    return false;
}

function getVisibleChildren(node, category) {
    if (category === "all") return node.children || [];

    return (node.children || []).filter(child =>
        getElementCategory(child, category) || getVisibleChildren(child, category).length > 0
    );
}

function expandFilteredPaths(node, category) {
    let containsMatch = getElementCategory(node, category);

    (node.children || []).forEach(function (child) {
        if (expandFilteredPaths(child, category)) {
            expandedStructureNodes.add(node.id);
            containsMatch = true;
        }
    });

    return containsMatch;
}

function renderElementDetails(node, depth) {
    const panel = document.getElementById("element-details");
    panel.replaceChildren();

    const heading = document.createElement("h3");
    heading.textContent = "Element details";
    panel.appendChild(heading);

    const tag = document.createElement("p");
    tag.className = "detail-tag";
    tag.textContent = "<" + node.tag + ">";
    panel.appendChild(tag);

    const details = document.createElement("dl");
    const addDetail = function (label, value) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = value || "None";
        details.append(term, description);
    };

    addDetail("Nesting level", String(depth));
    addDetail("ID", node.attributes.id || "None");
    addDetail("CSS classes", node.attributes.class || "None");
    addDetail("Child elements", String(node.childCount));
    if (node.text) addDetail("Text content", node.text);
    if (node.attributes.href) addDetail("Link destination", node.attributes.href);
    if (node.attributes.src) addDetail("Image source", node.attributes.src);
    if (node.attributes.action) addDetail("Form action", node.attributes.action);

    const shownAttributes = new Set([
        "id", "class", "href", "src", "action"
    ]);
    Object.keys(node.attributes).forEach(function (name) {
        if (!shownAttributes.has(name)) {
            addDetail(name, node.attributes[name]);
        }
    });

    if (Object.keys(node.attributes).length === 0) {
        addDetail("Attributes", "None");
    }

    panel.appendChild(details);
}

function renderStructureTree() {
    const container = document.getElementById("structure-tree");
    container.replaceChildren();

    if (!structureTreeData) {
        setEmptyState(container, "The analyzed page tree will appear here.");
        return;
    }

    const category = structureFilter.value;
    const visibleRoot = category === "all" ||
        getElementCategory(structureTreeData, category) ||
        getVisibleChildren(structureTreeData, category).length > 0;

    if (!visibleRoot) {
        setEmptyState(container, "No elements match this filter.");
        return;
    }

    const list = document.createElement("ul");
    list.className = "tree-list";

    const createTreeNode = function (node, depth) {
        const item = document.createElement("li");
        item.className = "tree-node";

        const visibleChildren = getVisibleChildren(node, category);
        const row = document.createElement("div");
        row.className = "tree-row";
        row.style.setProperty("--tree-depth", depth);

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "tree-toggle";
        toggle.disabled = visibleChildren.length === 0;
        toggle.textContent = visibleChildren.length
            ? expandedStructureNodes.has(node.id) ? "▾" : "▸"
            : "·";
        toggle.setAttribute(
            "aria-label",
            visibleChildren.length
                ? (expandedStructureNodes.has(node.id) ? "Collapse " : "Expand ") + node.tag
                : node.tag + " has no visible children"
        );

        if (visibleChildren.length) {
            toggle.addEventListener("click", function () {
                if (expandedStructureNodes.has(node.id)) {
                    expandedStructureNodes.delete(node.id);
                } else {
                    expandedStructureNodes.add(node.id);
                }
                renderStructureTree();
            });
        }

        const select = document.createElement("button");
        select.type = "button";
        select.className = "tree-element";
        select.setAttribute("aria-pressed", String(selectedStructureNodeId === node.id));
        select.addEventListener("click", function () {
            selectedStructureNodeId = node.id;
            renderElementDetails(node, depth);
            renderStructureTree();
        });

        const tagName = document.createElement("span");
        tagName.className = "tree-tag";
        tagName.textContent = node.tag;
        select.appendChild(tagName);

        if (node.attributes.id) {
            const id = document.createElement("span");
            id.className = "tree-attribute";
            id.textContent = "#" + node.attributes.id;
            select.appendChild(id);
        }

        if (node.attributes.class) {
            const classes = document.createElement("span");
            classes.className = "tree-attribute";
            classes.textContent = "." + node.attributes.class.split(/\s+/).slice(0, 2).join(".");
            select.appendChild(classes);
        }

        row.append(toggle, select);
        item.appendChild(row);

        if (visibleChildren.length && expandedStructureNodes.has(node.id)) {
            const children = document.createElement("ul");
            children.className = "tree-list tree-children";
            visibleChildren.forEach(child =>
                children.appendChild(createTreeNode(child, depth + 1))
            );
            item.appendChild(children);
        }

        return item;
    };

    list.appendChild(createTreeNode(structureTreeData, 0));
    container.appendChild(list);
}

function setStructureStatus(text, state) {
    const status = document.getElementById("structure-status");
    status.textContent = text;
    status.className = "structure-status" + (state ? " " + state : "");
}

function resetStructureExplorer(statusText, state) {
    structureTreeData = null;
    selectedStructureNodeId = null;
    expandedStructureNodes = new Set();
    renderStructureTree();
    const details = document.getElementById("element-details");
    details.replaceChildren();
    const detailsHeading = document.createElement("h3");
    detailsHeading.textContent = "Element details";
    const detailsPlaceholder = document.createElement("p");
    detailsPlaceholder.className = "empty-state";
    detailsPlaceholder.textContent = "Select an element in the tree to inspect its details.";
    details.append(detailsHeading, detailsPlaceholder);
    setStructureStatus(statusText, state);
}

async function loadStructure(url) {
    resetStructureExplorer("Loading the analyzed page structure…", "message-loading");

    try {
        const response = await fetch("/api/structure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url })
        });
        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error("The structure endpoint returned an invalid response.");
        }

        if (!response.ok) {
            throw new Error(data.error || "Could not load the website structure.");
        }

        structureTreeData = data.tree;
        expandedStructureNodes.add(data.tree.id);
        (data.tree.children || []).forEach(function (child) {
            if (["head", "body"].includes(child.tag)) expandedStructureNodes.add(child.id);
        });
        renderStructureTree();

        const truncationNote = data.truncated
            ? " Some elements are omitted because the structure response reached its safety limit."
            : "";
        setStructureStatus(
            "Showing " + data.nodeCount + " elements from " + data.title + "." + truncationNote,
            "message-success"
        );
    } catch (error) {
        structureTreeData = null;
        renderStructureTree();
        setStructureStatus(error.message || "Could not load the website structure.", "message-error");
    }
}

analyzeForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const url = websiteUrl.value.trim();
    message.textContent = "Checking the public website and its accessible stylesheets…";
    message.className = "message-loading";
    analyzeButton.disabled = true;
    analyzeButton.textContent = "Analyzing…";
    resetStructureExplorer("Waiting for website analysis…", "message-loading");

    try {
        const response = await fetch("/api/analyze", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ url: url })
        });

        let data;
        try {
            data = await response.json();
        } catch {
            throw new Error("The analyzer returned an invalid response.");
        }

        if (!response.ok) {
            throw new Error(data.error || "Analysis failed.");
        }

        document.getElementById("color-count").textContent = data.colors.length;
        document.getElementById("font-count").textContent = data.fonts.length;
        document.getElementById("link-count").textContent = data.linkCount;

        renderColors(data.colors);
        renderTypography(data);
        renderTokens(
            "spacing-list",
            data.spacing,
            (value, index) => "--spacing-" + (index + 1) + ": " + value + ";",
            "No spacing values found in the accessible styles."
        );
        renderRadii(data.radii);
        renderTokens(
            "shadow-list",
            data.shadows,
            value => value,
            "No shadow declarations found in the accessible styles.",
            null,
            "token-chip shadow-token"
        );
        renderLayout(data.layout);
        document.getElementById("page-title").textContent = data.title;
        document.getElementById("page-description").textContent = data.description;
        document.getElementById("page-url").textContent = data.url;
        document.getElementById("analysis-note").textContent = data.note;

        message.textContent = "Analysis complete for " + data.title + ".";
        message.className = "message-success";
        loadStructure(data.url);
    } catch (error) {
        message.textContent = error.message || "Could not analyze this website.";
        message.className = "message-error";
        setStructureStatus(
            "Structure is unavailable until website analysis succeeds.",
            "message-error"
        );
    } finally {
        analyzeButton.disabled = false;
        analyzeButton.textContent = "Analyze Website →";
    }
});

structureFilter.addEventListener("change", function () {
    selectedStructureNodeId = null;
    if (structureTreeData && structureFilter.value !== "all") {
        expandFilteredPaths(structureTreeData, structureFilter.value);
    }
    const details = document.getElementById("element-details");
    details.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = "Element details";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Select an element in the tree to inspect its details.";
    details.append(heading, empty);
    renderStructureTree();
});

document.addEventListener("click", async function (event) {
    const button = event.target.closest("button[data-copy]");
    if (!button) return;

    try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.classList.add("copied");
        message.textContent = button.classList.contains("color-swatch")
            ? "Color copied: " + button.dataset.copy
            : "CSS value copied: " + button.dataset.copy;
        message.className = "message-success";

        window.setTimeout(function () {
            button.classList.remove("copied");
        }, 1200);
    } catch {
        message.textContent = "Clipboard access was denied. Copy this value manually: " + button.dataset.copy;
        message.className = "message-error";
    }
});
