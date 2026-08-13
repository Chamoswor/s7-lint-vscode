"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const {
  DISABLE_RECOMMENDED_SEMANTIC_COLORS_COMMAND,
  INSTALL_RECOMMENDED_SEMANTIC_COLORS_COMMAND,
  RECOMMENDED_SEMANTIC_COLORS_SETTING,
  RECOMMENDED_SEMANTIC_PALETTES,
  withRecommendedSemanticColors,
  withoutRecommendedSemanticColors,
} = require("../out/semanticColors");

let passed = 0;
function test(name, run) {
  try {
    run();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
}

test("dark preset is scoped to the active theme", () => {
  const result = withRecommendedSemanticColors(undefined, "Default Dark Modern", "dark");
  assert.deepEqual(result, {
    "[Default Dark Modern]": {
      rules: { ...RECOMMENDED_SEMANTIC_PALETTES.dark },
    },
  });
});

test("light preset uses the light palette", () => {
  const result = withRecommendedSemanticColors(null, "Default Light Modern", "light");
  assert.deepEqual(result["[Default Light Modern]"].rules, RECOMMENDED_SEMANTIC_PALETTES.light);
});

test("DATA_BLOCK has a distinct preset color in dark and light themes", () => {
  for (const palette of Object.values(RECOMMENDED_SEMANTIC_PALETTES)) {
    assert.ok(palette.s7DataBlock, "DATA_BLOCK selector must be installed");
    const baseRoleColors = Object.entries(palette)
      .filter(([selector]) => !selector.includes("."))
      .map(([, color]) => color);
    assert.equal(
      baseRoleColors.filter((color) => color.toUpperCase() === palette.s7DataBlock.toUpperCase()).length,
      1,
      "DATA_BLOCK color must be distinct from every other managed semantic role"
    );
    assert.equal(palette["s7DataBlock.s7Container"], palette.s7DataBlock, "container modifier must preserve DATA_BLOCK identity");
    assert.equal(palette["s7CallableInstance.s7Container"], palette.s7CallableInstance, "container modifier must preserve callable-instance identity");
  }
});

test("PLC tags have a distinct rose identity across value capabilities", () => {
  assert.equal(RECOMMENDED_SEMANTIC_PALETTES.dark.s7PlcTag, "#D16D9E");
  assert.equal(RECOMMENDED_SEMANTIC_PALETTES.light.s7PlcTag, "#C43E73");
  for (const palette of Object.values(RECOMMENDED_SEMANTIC_PALETTES)) {
    assert.notEqual(palette.s7PlcTag, palette.s7DataBlock);
    assert.notEqual(palette.s7PlcTag, palette.s7CallableInstance);
    assert.equal(palette["s7PlcTag.s7Container"], palette.s7PlcTag);
    assert.equal(palette["s7PlcTag.s7Indexable"], palette.s7PlcTag);
    assert.equal(palette["s7PlcTag.s7Container.s7Indexable"], palette.s7PlcTag);
  }
});

test("container, indexable, and combined capability selectors are installed", () => {
  for (const palette of Object.values(RECOMMENDED_SEMANTIC_PALETTES)) {
    for (const tokenType of ["property", "parameter", "variable"]) {
      const container = palette[`${tokenType}.s7Container`];
      const indexable = palette[`${tokenType}.s7Indexable`];
      const both = palette[`${tokenType}.s7Container.s7Indexable`];
      assert.ok(container && indexable && both, `${tokenType} capability selectors must be installed`);
      assert.equal(new Set([container.toUpperCase(), indexable.toUpperCase(), both.toUpperCase()]).size, 3);
    }
  }
});

test("container-only values use the steel-blue palette and migrate old lavender presets", () => {
  assert.equal(RECOMMENDED_SEMANTIC_PALETTES.dark["property.s7Container"], "#8FAFD9");
  assert.equal(RECOMMENDED_SEMANTIC_PALETTES.light["property.s7Container"], "#365F8D");
  for (const palette of Object.values(RECOMMENDED_SEMANTIC_PALETTES)) {
    for (const tokenType of ["property", "parameter", "variable"]) {
      const container = palette[`${tokenType}.s7Container`];
      assert.equal(container, palette["property.s7Container"], "container roles must share one structural color");
      assert.notEqual(container, palette.s7CallableType, "containers must remain distinct from callable types");
      assert.notEqual(container, palette.s7CallableInstance, "containers must remain distinct from callable instances");
    }
  }

  const dark = withRecommendedSemanticColors(
    { "[Dark]": { rules: { "property.s7Container": "#C8A2C8", "parameter.s7Container": "#C8A2C8" } } },
    "Dark",
    "dark",
    false
  );
  assert.equal(dark["[Dark]"].rules["property.s7Container"], "#8FAFD9");
  assert.equal(dark["[Dark]"].rules["parameter.s7Container"], "#8FAFD9");

  const light = withRecommendedSemanticColors(
    { "[Light]": { rules: { "variable.s7Container": "#7B3F8C" } } },
    "Light",
    "light",
    false
  );
  assert.equal(light["[Light]"].rules["variable.s7Container"], "#365F8D");
});

test("concrete built-in type families share one calm blue and migrate old family colors", () => {
  for (const palette of Object.values(RECOMMENDED_SEMANTIC_PALETTES)) {
    const builtInBlue = palette.s7IntegerType;
    for (const selector of ["s7BooleanType", "s7FloatType", "s7TextType"]) {
      assert.equal(palette[selector], builtInBlue, `${selector} must share the concrete built-in type color`);
    }
    assert.notEqual(palette.s7TemporalType, builtInBlue, "temporal types must retain their distinct group color");
    assert.notEqual(palette.s7GenericType, builtInBlue, "generic types and constructors must retain their distinct group color");
  }

  const dark = withRecommendedSemanticColors(
    {
      "[Dark]": {
        rules: {
          s7BooleanType: "#D16D9E",
          s7FloatType: "#B5CEA8",
          s7TextType: "#CE9178",
        },
      },
    },
    "Dark",
    "dark",
    false
  );
  for (const selector of ["s7BooleanType", "s7FloatType", "s7TextType"]) {
    assert.equal(dark["[Dark]"].rules[selector], "#4FC1FF");
  }

  const light = withRecommendedSemanticColors(
    {
      "[Light]": {
        rules: {
          s7BooleanType: "#C43E73",
          s7FloatType: "#098658",
          s7TextType: "#A31515",
        },
      },
    },
    "Light",
    "light",
    false
  );
  for (const selector of ["s7BooleanType", "s7FloatType", "s7TextType"]) {
    assert.equal(light["[Light]"].rules[selector], "#0070C1");
  }
});

test("existing global, other-theme, and selected-theme rules are preserved", () => {
  const existing = {
    enabled: false,
    rules: { variable: "#101010" },
    "[Other Theme]": { rules: { type: "#202020" } },
    "[My Dark]": {
      enabled: false,
      customFlag: "keep",
      rules: { comment: "#303030", s7TemporalType: "#OLD" },
    },
  };
  const snapshot = JSON.stringify(existing);
  const result = withRecommendedSemanticColors(existing, "My Dark", "dark");

  assert.equal(JSON.stringify(existing), snapshot, "input must not be mutated");
  assert.equal(result.enabled, false);
  assert.deepEqual(result.rules, { variable: "#101010" });
  assert.deepEqual(result["[Other Theme]"], { rules: { type: "#202020" } });
  assert.equal(result["[My Dark]"].enabled, false);
  assert.equal(result["[My Dark]"].customFlag, "keep");
  assert.equal(result["[My Dark]"].rules.comment, "#303030");
  assert.equal(result["[My Dark]"].rules.s7TemporalType, RECOMMENDED_SEMANTIC_PALETTES.dark.s7TemporalType);
});

test("automatic activation preserves manual S7 values and migrates legacy preset values", () => {
  const existing = {
    "[My Dark]": {
      rules: {
        s7IntegerType: "#123456",
        s7ArrayType: "#4EC9B0",
        s7UdtType: "#C586C0",
      },
    },
  };
  const result = withRecommendedSemanticColors(existing, "My Dark", "dark", false);
  assert.equal(result["[My Dark]"].rules.s7IntegerType, "#123456", "manual customization wins");
  assert.equal(result["[My Dark]"].rules.s7ArrayType, undefined, "managed retired selector is removed");
  assert.equal(result["[My Dark]"].rules.s7UdtType, RECOMMENDED_SEMANTIC_PALETTES.dark.s7UdtType);
  assert.equal(result["[My Dark]"].rules.s7GenericType, RECOMMENDED_SEMANTIC_PALETTES.dark.s7GenericType);
  assert.equal(result["[My Dark]"].rules.s7CallableType, RECOMMENDED_SEMANTIC_PALETTES.dark.s7CallableType);
});

test("disable removes only managed presets and cleans an old installer shell", () => {
  const existing = {
    enabled: false,
    "[Dark]": {
      enabled: true,
      rules: { ...RECOMMENDED_SEMANTIC_PALETTES.dark, s7ArrayType: "#4EC9B0" },
    },
    "[Light]": {
      rules: {
        ...RECOMMENDED_SEMANTIC_PALETTES.light,
        s7CallableInstance: "#123456",
        s7ArrayType: "#654322",
        comment: "#654321",
      },
    },
  };
  const result = withoutRecommendedSemanticColors(existing);
  assert.deepEqual(result, {
    enabled: false,
    "[Light]": {
      rules: {
        s7CallableInstance: "#123456",
        s7ArrayType: "#654322",
        comment: "#654321",
      },
    },
  });
});

test("disable can remove the entire customization setting", () => {
  const existing = { "[Dark]": { rules: { ...RECOMMENDED_SEMANTIC_PALETTES.dark } } };
  assert.equal(withoutRecommendedSemanticColors(existing), undefined);
});

test("manifest contributes the user-facing command", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"));
  const commands = new Map(manifest.contributes.commands.map((entry) => [entry.command, entry.title]));
  assert.equal(commands.get(INSTALL_RECOMMENDED_SEMANTIC_COLORS_COMMAND), "S7 Lint: Install Recommended Semantic Colors");
  assert.equal(commands.get(DISABLE_RECOMMENDED_SEMANTIC_COLORS_COMMAND), "S7 Lint: Disable Recommended Semantic Colors");
  assert.equal(manifest.contributes.configuration.properties[RECOMMENDED_SEMANTIC_COLORS_SETTING].default, true);
  for (const language of ["s7scl", "s7dcl", "s7udt"]) {
    assert.equal(manifest.contributes.configurationDefaults[`[${language}]`]["editor.semanticHighlighting.enabled"], true);
    const scopes = manifest.contributes.semanticTokenScopes.find((entry) => entry.language === language)?.scopes;
    assert.ok(scopes?.s7InterfaceMember?.includes("variable.parameter"), `${language} must map interface members to parameter fallback scope`);
    assert.ok(scopes?.s7PlcTag?.includes("variable.other.global"), `${language} must map PLC tags to a global-variable fallback scope`);
  }
  const interfaceMember = manifest.contributes.semanticTokenTypes.find((entry) => entry.id === "s7InterfaceMember");
  assert.equal(interfaceMember?.superType, "parameter", "interface members must inherit the active theme's parameter color");
  const plcTag = manifest.contributes.semanticTokenTypes.find((entry) => entry.id === "s7PlcTag");
  assert.equal(plcTag?.superType, "variable", "PLC tags must inherit the active theme's variable color");
});

console.log(`\n${passed} passed, 0 failed.`);
