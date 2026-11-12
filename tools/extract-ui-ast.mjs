import ts from 'typescript';
import { UI_PROPERTIES, GENERIC_PROP_NAMES, isEnglishSource, isFragmentLiteral } from '../dist/bundle.js';

/** Developer-only extraction using public TypeScript AST APIs; never executes the source. */
export function extractUiStringsAst(source) {
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
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) record(node.text, kind);
    else if (ts.isTemplateExpression(node)) record(node.getText(file).slice(1, -1), 'template');
  };
  const properties = new Set([...UI_PROPERTIES, ...GENERIC_PROP_NAMES]);
  const walk = node => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (properties.has(name)) literal(node.initializer, name);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createElement') {
      const tag = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '';
      for (const argument of node.arguments.slice(2)) literal(argument, tag === 'button' ? 'button' : /^h[1-6]$/.test(tag) ? 'heading' : 'text');
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return [...found.values()].map(row => ({ ...row, kinds: [...row.kinds].sort() })).sort((a, b) => a.text.localeCompare(b.text));
}
