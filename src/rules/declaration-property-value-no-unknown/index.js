import * as cssTree from "css-tree";
import mdnData from "mdn-data";
import * as isPlainObject from "is-plain-object";
import * as typeGuards from "../../utils/typeGuards.js";
import declarationValueIndex from "../../utils/declarationValueIndex.js";
import getDeclarationValue from "../../utils/getDeclarationValue.js";
import isCustomProperty from "../../utils/isCustomPropertySet.js";
import isStandardSyntaxDeclaration from "../../utils/isStandardSyntaxDeclaration.js";
import isStandardSyntaxProperty from "../../utils/isStandardSyntaxProperty.js";
import isStandardSyntaxValue from "../../utils/isStandardSyntaxValue.js";
import matchesStringOrRegExp from "../../utils/matchesStringOrRegExp.js";
import * as atKeywords from "../../utils/atKeywords.js";
import validateObjectWithArrayProps from "../../utils/validateObjectWithArrayProps.js";
import stylelint from "stylelint";
import { isFunctionCall } from "../../utils/validateTypes.js";
import findOperators from "../../utils/sassValueParser/index.js";
import { parseFunctionArguments } from "../../utils/parseFunctionArguments.js";
import {
  isDollarVar,
  isIfStatement,
  isNestedProperty
} from "../../utils/validateTypes.js";
import namespace from "../../utils/namespace.js";
import ruleUrl from "../../utils/ruleUrl.js";

const syntaxes = mdnData.css.syntaxes;

const { utils } = stylelint;

const ruleName = namespace("declaration-property-value-no-unknown");

const messages = utils.ruleMessages(ruleName, {
  rejected: (property, value) =>
    `Unexpected unknown value "${value}" for property "${property}"`,
  rejectedParseError: (property, value) =>
    `Cannot parse property value "${value}" for property "${property}"`
});

const meta = {
  url: ruleUrl(ruleName)
};

const SYNTAX_DESCRIPTOR = /^syntax$/i;

function extractFunctionName(inputString) {
  const matches = [...inputString.matchAll(/(?:\s*([\w\-$]+)\s*)?\(/g)].flat();
  return matches;
}

function hasDollarVarArg(functionCall) {
  for (const i of parseFunctionArguments(functionCall)) {
    if (isFunctionCall(i.value)) return hasDollarVarArg(i.value);
    if (isDollarVar(i.value)) return true;
  }
  return false;
}

const unsupportedFunctions = ["clamp", "min", "max", "env"];
const mathOperators = ["+", "/", "-", "*", "%"];

function rule(primary, secondaryOptions) {
  return (root, result) => {
    const validOptions = utils.validateOptions(
      result,
      ruleName,
      { actual: primary },
      {
        actual: secondaryOptions,
        possible: {
          ignoreProperties: [validateObjectWithArrayProps],
          propertiesSyntax: [isPlainObject.isPlainObject],
          typesSyntax: [isPlainObject.isPlainObject]
        },
        optional: true
      }
    );

    if (!validOptions) {
      return;
    }

    const ignoreProperties = Array.from(
      Object.entries(secondaryOptions?.ignoreProperties ?? {})
    );

    /** @type {(name: string, propValue: string) => boolean} */
    const isPropIgnored = (name, value) => {
      const [, valuePattern] =
        ignoreProperties.find(([namePattern]) =>
          matchesStringOrRegExp(name, namePattern)
        ) || [];

      return valuePattern && matchesStringOrRegExp(value, valuePattern);
    };

    const propertiesSyntax = {
      "text-box-edge":
        "auto | [ text | cap | ex | ideographic | ideographic-ink ] [ text | alphabetic | ideographic | ideographic-ink ]?",
      "text-box-trim": "none | trim-start | trim-end | trim-both",
      "view-timeline":
        "[ <'view-timeline-name'> [ <'view-timeline-axis'> || <'view-timeline-inset'> ]? ]#",
      ...secondaryOptions?.propertiesSyntax
    };
    const typesSyntax = { ...secondaryOptions?.typesSyntax };

    /** @type {Map<string, string>} */
    const typedCustomPropertyNames = new Map();

    // Unless we tracked return values of declared functions, they're all valid.
    root.walkAtRules("function", atRule => {
      unsupportedFunctions.push(extractFunctionName(atRule.params)[1]);
    });

    root.walkAtRules(/^property$/i, atRule => {
      const propName = atRule.params.trim();

      if (!propName || !atRule.nodes || !isCustomProperty(propName)) return;

      for (const node of atRule.nodes) {
        if (
          typeGuards.isDeclaration(node) &&
          SYNTAX_DESCRIPTOR.test(node.prop)
        ) {
          const value = node.value.trim();
          const unquoted = cssTree.string.decode(value);

          // Only string values are valid.
          // We can not check the syntax of this property.
          if (unquoted === value) continue;

          // Any value is allowed in this custom property.
          // We don't need to check this property.
          if (unquoted === "*") continue;

          // https://github.com/csstree/csstree/pull/256
          // We can circumvent this issue by prefixing the property name,
          // making it a vendor-prefixed property instead of a custom property.
          // No one should be using `-stylelint--` as a property prefix.
          //
          // When this is resolved `typedCustomPropertyNames` can become a `Set<string>`
          // and the prefix can be removed.
          const prefixedPropName = `-stylelint${propName}`;

          typedCustomPropertyNames.set(propName, prefixedPropName);
          propertiesSyntax[prefixedPropName] = unquoted;
        }
      }
    });

    const forkedLexer = cssTree.fork({
      properties: propertiesSyntax,
      types: typesSyntax
    }).lexer;

    root.walkDecls(decl => {
      let { prop } = decl;
      const { parent } = decl;
      const value = getDeclarationValue(decl);

      // Handle nested properties by reasigning `prop` to the compound property.
      if (parent.selector && isNestedProperty(parent.selector)) {
        let pointer = parent;
        prop = String(decl.prop);
        while (
          pointer &&
          pointer.selector &&
          pointer.selector[pointer.selector.length - 1] === ":" &&
          pointer.selector.substring(0, 2) !== "--"
        ) {
          prop = pointer.selector.replace(":", "") + "-" + prop;
          pointer = pointer.parent;
        }
      }

      //csstree/csstree#243
      // NOTE: CSSTree's `fork()` doesn't support `-moz-initial`, but it may be possible in the future.
      if (/^-moz-initial$/i.test(value)) return;

      if (!isStandardSyntaxDeclaration(decl)) return;

      if (!isStandardSyntaxProperty(prop)) return;

      if (!isStandardSyntaxValue(value)) return;

      if (isCustomProperty(prop) && !typedCustomPropertyNames.has(prop)) return;

      if (isPropIgnored(prop, value)) return;

      // Unless we tracked values of variables, they're all valid.
      if (value.split(" ").some(val => isDollarVar(val))) return;
      if (value.split(" ").some(val => hasDollarVarArg(val))) return;
      if (value.split(" ").some(val => containsCustomFunction(val))) return;

      /** @type {import('css-tree').CssNode} */
      let cssTreeValueNode;

      try {
        cssTreeValueNode = cssTree.parse(value, {
          context: "value",
          positions: true
        });

        if (containsCustomFunction(cssTreeValueNode)) return;
        if (containsUnsupportedFunction(cssTreeValueNode)) return;
      } catch (e) {
        const index = declarationValueIndex(decl);
        const endIndex = index + value.length;

        // Hidden declarations
        if (isIfStatement(value)) return;
        if (hasDollarVarArg(value)) return;
        const operators = findOperators({ string: value }).map(o => o.symbol);

        for (const operator of operators) {
          if (mathOperators.includes(operator)) {
            return;
          }
        }

        utils.report({
          message: messages.rejectedParseError(prop, value),
          node: decl,
          index,
          endIndex,
          result,
          ruleName
        });

        return;
      }

      const { error } =
        parent &&
        typeGuards.isAtRule(parent) &&
        !atKeywords.nestingSupportedAtKeywords.has(parent.name.toLowerCase())
          ? forkedLexer.matchAtruleDescriptor(
              parent.name,
              prop,
              cssTreeValueNode
            )
          : forkedLexer.matchProperty(
              typedCustomPropertyNames.get(prop) ?? prop,
              cssTreeValueNode
            );

      if (!error) return;

      if (!("mismatchLength" in error)) return;

      const { name, rawMessage, loc } = error;

      if (name !== "SyntaxMatchError") return;

      if (rawMessage !== "Mismatch") return;

      const valueIndex = declarationValueIndex(decl);
      const mismatchValue = value.slice(loc.start.offset, loc.end.offset);
      const operators = findOperators({ string: value }).map(o => o.symbol);

      for (const operator of operators) {
        if (mathOperators.includes(operator)) {
          return;
        }
      }

      utils.report({
        message: messages.rejected(prop, mismatchValue),
        node: decl,
        index: valueIndex + loc.start.offset,
        endIndex: valueIndex + loc.end.offset,
        result,
        ruleName
      });
    });
  };
}

/**
 *
 * @see csstree/csstree#164 min, max, clamp
 * @see csstree/csstree#245 env
 *
 * @param {import('css-tree').CssNode} cssTreeNode
 * @returns {boolean}
 */
function containsUnsupportedFunction(cssTreeNode) {
  return Boolean(
    cssTree.find(
      cssTreeNode,
      node =>
        node.type === "Function" &&
        ["clamp", "min", "max", "env"].includes(node.name)
    )
  );
}

function containsCustomFunction(cssTreeNode) {
  return Boolean(
    cssTree.find(
      cssTreeNode,
      node =>
        node.type === "Function" &&
        (unsupportedFunctions.includes(node.name) ||
          !syntaxes[node.name + "()"])
    )
  );
}

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = meta;

export default rule;
