interface Token {kind:'word'|'id'|'value'|'symbol';text:string}
/** Conservative bounded lexer/parser. Unrecognised SQL always requires approval. */
export function isReadOnly(method:string,sql:string):boolean {
  if(!['query','single','scalar'].includes(method)||Buffer.byteLength(sql)>65536)return false;
  const tokens:Token[]=[];
  for(let i=0;i<sql.length;){
    const rest=sql.slice(i);let match:RegExpMatchArray|null;
    if((match=rest.match(/^\s+/))){i+=match[0].length;continue;}
    if((match=rest.match(/^[A-Za-z_][A-Za-z_0-9]*/))){tokens.push({kind:'word',text:match[0].toUpperCase()});i+=match[0].length;continue;}
    if((match=rest.match(/^-?\d+(?:\.\d+)?/))){tokens.push({kind:'value',text:match[0]});i+=match[0].length;continue;}
    if(rest[0]==="'"||rest[0]==='`'){
      const quote=rest[0];let j=1,closed=false;
      while(j<rest.length){if(rest[j]==='\\')return false;if(rest[j]===quote){if(rest[j+1]===quote){j+=2;continue;}closed=true;j++;break;}j++;}
      if(!closed)return false;tokens.push({kind:quote==='`'?'id':'value',text:rest.slice(0,j)});i+=j;continue;
    }
    if((match=rest.match(/^(?:<=|>=|<>|!=|[?*,().;=<>])/))){tokens.push({kind:match[0]==='?'?'value':'symbol',text:match[0]});i+=match[0].length;continue;}
    return false;
  }
  if(tokens.length>10000)return false;
  let p=0,depth=0;
  const peek=()=>tokens[p]?.text;
  const take=(text:string)=>peek()===text?(p++,true):false;
  const reserved=new Set(['SELECT','FROM','WHERE','ORDER','BY','LIMIT','OFFSET','ASC','DESC','AND','OR','IS','NOT','NULL','LIKE','IN','BETWEEN','COUNT','FOR','LOCK','INTO','OUTFILE','DUMPFILE','UNION','WITH','PROCEDURE','JOIN','AS']);
  function identifier(){const t=tokens[p];if(t?.kind==='id'||(t?.kind==='word'&&!reserved.has(t.text))){p++;return true;}return false;}
  function column(){if(!identifier())return false;if(take('.'))return identifier();return true;}
  function scalar(){if(tokens[p]?.kind==='value'){p++;return true;}if(take('NULL'))return true;return column();}
  function selected(){if(take('*'))return true;if(take('COUNT'))return take('(')&&(take('*')||identifier())&&take(')');return scalar();}
  function predicate():boolean {
    if(++depth>32)return false;
    let good:boolean;
    if(take('('))good=expression()&&take(')');
    else if(!scalar())good=false;
    else if(['=','!=','<>','<','>','<=','>='].includes(peek()??'')){p++;good=scalar();}
    else if(take('IS')){take('NOT');good=take('NULL');}
    else {
      take('NOT');
      if(take('LIKE'))good=scalar();
      else if(take('BETWEEN'))good=scalar()&&take('AND')&&scalar();
      else if(take('IN')){
        good=take('(');let n=0;
        do{if(tokens[p]?.kind==='value'){p++;n++;}else if(take('NULL'))n++;else{good=false;break;}}while(take(','));
        good=good&&n>0&&take(')');
      }else good=false;
    }
    depth--;return good;
  }
  function expression():boolean {if(!predicate())return false;while(take('AND')||take('OR'))if(!predicate())return false;return true;}
  if(!take('SELECT')||!selected())return false;
  while(take(','))if(!selected())return false;
  if(take('FROM')&&!column())return false;
  if(take('WHERE')&&!expression())return false;
  if(take('ORDER')){if(!take('BY')||!column())return false;take('ASC')||take('DESC');while(take(',')){if(!column())return false;take('ASC')||take('DESC');}}
  const integer=()=>{const t=tokens[p];if(t&&(t.text==='?'||/^\d+$/.test(t.text))){p++;return true;}return false;};
  if(take('LIMIT')){if(!integer())return false;if(take('OFFSET')&&!integer())return false;}
  take(';');return p===tokens.length;
}
