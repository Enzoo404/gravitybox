import ts from 'typescript';
import { UI_PROPERTIES, GENERIC_PROP_NAMES, isEnglishSource, isFragmentLiteral } from '../dist/bundle.js';

const JSX_RUNTIME_CALLEES = new Set(['jsx', 'jsxs', 'jsxDEV', '_jsx', '_jsxs']);

function resolveCalleeName(expr) {
  if (!expr) return '';
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr)) return resolveCalleeName(expr.expression);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return resolveCalleeName(expr.right);
  }
  return '';
}

/** Developer-only extraction using public TypeScript AST APIs; never executes the source. */
export function extractUiStringsAst(source, options = {}) {
  const includeJsxRuntime = options?.includeJsxRuntime === true;
  const file = ts.createSourceFile('official-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw Error('界面包未通过AST语法解析，未登记提取结果');
  const found = new Map();
  const record = (text, kind) => {
    if (!isEnglishSource(text.replace(/\$\{[^}]+\}/g, 'variable'))) return;
    const row = found.get(text) ?? { text, kinds: new Set(), count: 0 };
    row.kinds.add(kind);
    if (isFragmentLiteral(text)) row.kinds.add('fragment');
    row.count++;
    found.set(text, row);
  };
  const literal = (node, kind) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node.text, kind);
    else if (ts.isTemplateExpression(node)) record(node.getText(file).slice(1, -1), 'template');
    else if (includeJsxRuntime && ts.isParenthesizedExpression(node)) literal(node.expression, kind);
    else if (includeJsxRuntime && ts.isConditionalExpression(node)) {
      literal(node.whenTrue, kind);
      literal(node.whenFalse, kind);
    } else if (includeJsxRuntime && ts.isArrayLiteralExpression(node)) {
      for (const el of node.elements) literal(el, kind);
    }
  };
  const tagKind = tag => (tag === 'button' ? 'button' : /^h[1-6]$/.test(tag) ? 'heading' : 'text');
  const properties = new Set([...UI_PROPERTIES, ...GENERIC_PROP_NAMES]);
  const walk = node => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (properties.has(name)) literal(node.initializer, name);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : (includeJsxRuntime ? resolveCalleeName(node.expression) : '');
      if (callee === 'createElement') {
        const tag = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '';
        for (const argument of node.arguments.slice(2)) literal(argument, tagKind(tag));
      } else if (includeJsxRuntime && JSX_RUNTIME_CALLEES.has(callee)) {
        const tag = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '';
        const propsArg = node.arguments[1];
        if (propsArg && ts.isObjectLiteralExpression(propsArg)) {
          for (const prop of propsArg.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : '';
              if (pName === 'children') literal(prop.initializer, tagKind(tag));
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return [...found.values()].map(row => ({ ...row, kinds: [...row.kinds].sort() })).sort((a, b) => a.text.localeCompare(b.text));
}
