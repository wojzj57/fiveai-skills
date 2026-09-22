/** Ordinary synchronous server-only compiler. No host access or process isolation. */
import ts from "typescript";
import { performance } from "node:perf_hooks";
export interface Diagnostic { code: number; message: string; line: number | null; column: number | null }
export interface Compilation { javascript: string; hostJavascript:string; sourceMap: string | null; hostSourceMap:string|null; diagnostics: Diagnostic[]; elapsedMs: number }
const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, sourceMap: true, newLine: ts.NewLineKind.LineFeed };
// Standard transforms from the pinned compiler preserve async language semantics.
const transforms=ts as typeof ts & {transformES2018:ts.TransformerFactory<ts.SourceFile>;transformES2017:ts.TransformerFactory<ts.SourceFile>};
const hostHelpers:ts.TransformerFactory<ts.SourceFile>=context=>{
  const visit:ts.Visitor=node=>{
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)){
      if(node.expression.text==='__awaiter')return context.factory.updateCallExpression(node,context.factory.createIdentifier('__fiveaiAwaiter'),node.typeArguments,ts.visitNodes(node.arguments,visit) as ts.NodeArray<ts.Expression>);
      if(node.expression.text==='__asyncGenerator')return context.factory.updateCallExpression(node,context.factory.createIdentifier('__fiveaiAsyncGenerator'),node.typeArguments,[context.factory.createIdentifier('__await'),...ts.visitNodes(node.arguments,visit) as ts.NodeArray<ts.Expression>]);
    }
    return ts.visitEachChild(node,visit,context);
  };
  return source=>ts.visitNode(source,visit) as ts.SourceFile;
};
export function compile({code}: {code:string}): Compilation {
  const started = performance.now();
  if (Buffer.byteLength(code, "utf8") > 65536) throw new Error("INPUT_TOO_LARGE: code exceeds 64KiB");
  const source = "(async function(args) {\n" + code + "\n})";
  const file = ts.createSourceFile("snippet.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics: Diagnostic[] = [];
  const reject = (node:ts.Node, message:string) => { const p=file.getLineAndCharacterOfPosition(node.getStart(file)); diagnostics.push({code:0,message,line:Math.max(1,p.line),column:p.character+1}); };
  function visit(node:ts.Node):void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))) reject(node,"Module import/export is not allowed");
    if (ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text==="require"))) reject(node,"import/require is not allowed");
    ts.forEachChild(node,visit);
  }
  visit(file);
  const result = ts.transpileModule(source,{fileName:"snippet.ts",compilerOptions:options,reportDiagnostics:true});
  const hostResult=ts.transpileModule('return '+source,{fileName:'snippet.ts',compilerOptions:options,transformers:{before:[transforms.transformES2018,transforms.transformES2017],after:[hostHelpers]}});
  for (const d of result.diagnostics ?? []) {
    if (d.category!==ts.DiagnosticCategory.Error) continue;
    const p=d.file && d.start!==undefined ? d.file.getLineAndCharacterOfPosition(d.start):null;
    diagnostics.push({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText," "),line:p?Math.max(1,p.line):null,column:p?p.character+1:null});
  }
  const javascript=result.outputText.replace(/;?\s*\/\/# sourceMappingURL=.*$/m,"").trim().replace(/;$/,"");
  if (Buffer.byteLength(javascript,"utf8") + Buffer.byteLength(result.sourceMapText ?? "","utf8") > 256*1024) throw new Error("RESULT_TOO_LARGE: compiled output exceeds budget");
  const hostJavascript='(function(){\n'+hostResult.outputText.replace(/;?\s*\/\/# sourceMappingURL=.*$/m,'').trim().replace(/;$/,'')+'\n})()';
  if(Buffer.byteLength(hostJavascript)+Buffer.byteLength(hostResult.sourceMapText??'')>262144)throw new Error('RESULT_TOO_LARGE');
  if(!diagnostics.length)for(const expression of [javascript,hostJavascript])try{new Function('return ('+expression+');');}catch(error){diagnostics.push({code:0,message:String(error),line:null,column:null});break;}
  return {javascript,hostJavascript,sourceMap:result.sourceMapText ?? null,hostSourceMap:hostResult.sourceMapText??null,diagnostics,elapsedMs:performance.now()-started};
}
export function initialize(): {version:string;warmupMs:number} {
  const start=performance.now(); compile({code:"const ready: number = 1; return ready;"});
  return {version:ts.version,warmupMs:performance.now()-start};
}
