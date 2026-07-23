"use strict";

const editor = document.getElementById('bodyEditBox'); // 실제 편집 소스 (좌측 패널)
const previewContent = document.getElementById('previewContent'); // 우측 미리보기 (읽기 전용 미러)
const canvas = document.getElementById('canvas');
const canvasOuter = document.getElementById('canvas-outer');
const viewport = document.getElementById('preview-viewport');
const canvasInfo = document.getElementById('canvasInfo');

const CH = { ldq:'“', rdq:'”', lsq:'‘', rsq:'’', ellipsis:'⋯', bar:'︱' };

/* ---------------- 기본값 ---------------- */
const DEFAULTS = {
  fontFamily: "'Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif",
  fontWeight: 400,
  align: 'center',
  wordBreak: 'normal',
  size: 16,
  letterSpacing: 0,
  lineHeight: 24,
  paragraphSpacing: 12,
  tracking: 100,
  ratio: 'auto',
  width: 600,
  padX: 40,
  padY: 60,
  bgColor: '#ffffff',
  zoom: 100
};

let state = JSON.parse(JSON.stringify(DEFAULTS));
state.bgImage = null;
state.bgImageSize = 100;
let bgMode = 'color';

/* ---------------- 문서 블록 모델: 본문 텍스트 1개 + 메시지/프로필 블록들 ---------------- */
let blocks = [{id:'text', type:'text'}];
let messages = [];

/* ---------------- 미리보기 미러링 (우측 = 읽기 전용, 블록 순서대로 렌더) ---------------- */
function syncPreview(){
  renderPreviewBlocks();
}
const mirrorObserver = new MutationObserver(()=> syncPreview());
mirrorObserver.observe(editor, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['style','class']});

/* ---------------- selection 유지 ---------------- */
let savedRange = null;

document.addEventListener('selectionchange', ()=>{
  const sel = window.getSelection();
  if (sel.rangeCount>0){
    const r = sel.getRangeAt(0);
    if (editor.contains(r.commonAncestorContainer)){
      savedRange = r.collapsed ? null : r.cloneRange();
    }
  }
});

function restoreSelection(){
  if (savedRange){
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
}

function preventBlur(el){
  el.addEventListener('mousedown', e=>e.preventDefault());
}

/* ---------------- 선택영역 스타일 래핑 / 전체 기본값 적용 ---------------- */
function setGlobalStyle(styleObj){
  Object.assign(editor.style, styleObj);
  Object.assign(previewContent.style, styleObj);
}

function wrapSelectionStyle(styleObj){
  editor.focus();
  if (savedRange && !savedRange.collapsed && editor.contains(savedRange.commonAncestorContainer)){
    const range = savedRange.cloneRange();
    const span = document.createElement('span');
    Object.assign(span.style, styleObj);
    const content = range.extractContents();
    span.appendChild(content);
    range.insertNode(span);
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(newRange);
    savedRange = newRange.cloneRange();
    return true;
  } else {
    setGlobalStyle(styleObj);
    return false;
  }
}

function applyExecCommand(cmd){
  editor.focus();
  restoreSelection();
  document.execCommand(cmd, false, null);
}

/* ---------------- 본문 서식 버튼 ---------------- */
[['btnBold','bold'],['btnItalic','italic'],['btnUnderline','underline'],['btnStrike','strikeThrough']].forEach(([id,cmd])=>{
  const btn = document.getElementById(id);
  preventBlur(btn);
  btn.addEventListener('click', ()=> applyExecCommand(cmd));
});

document.getElementById('btnReset').addEventListener('click', ()=>{
  if(!confirm('본문 내용과 모든 서식이 초기화돼. 계속할까?')) return;
  editor.innerHTML='';
  state = JSON.parse(JSON.stringify(DEFAULTS));
  state.bgImage = null;
  state.bgImageSize = 100;
  bgMode = 'color';
  setBgMode('color');
  messages = [];
  snippets = [];
  blocks = [{id:'text', type:'text'}];
  renderMessageBoxes();
  renderSnippets();
  sourceState = {enabled:false, text:'', position:'bottom-right', offsetX:20, offsetY:20, color:'#888888', size:12};
  applySourceStateToUI();
  msgFontState = {fontFamily:"'Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif", weight:400, size:14, letterSpacing:0};
  applyMsgFontStateToUI();
  applyStateToUI();
  applyGlobalStyles();
  syncPreview();
});

/* ---------------- 특수문자 삽입 ---------------- */
function insertTextAtCursor(text){
  editor.focus();
  restoreSelection();
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.getRangeAt(0).commonAncestorContainer)){
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  document.execCommand('insertText', false, text);
}

[['btnInsDQ', CH.ldq+CH.rdq],['btnInsSQ', CH.lsq+CH.rsq],['btnInsEllipsis', CH.ellipsis],['btnInsBar', CH.bar]].forEach(([id,ch])=>{
  const btn = document.getElementById(id);
  preventBlur(btn);
  btn.addEventListener('click', ()=> insertTextAtCursor(ch));
});

/* ---------------- IME(한글) 조합 상태 추적 ----------------
   한글 자모를 조합하는 도중에 아래 줄바꿈/삭제 커스텀 처리가 끼어들면 조합이 깨지므로,
   조합 중에는 keydown 핸들러가 개입하지 않도록 플래그로 막아둠. */
let isComposingIME = false;
editor.addEventListener('compositionstart', ()=>{ isComposingIME = true; });
editor.addEventListener('compositionend', ()=>{ isComposingIME = false; });

/* ---------------- 문단(줄) 단위 구조 처리 ----------------
   기본 contenteditable 동작에만 맡기지 않고, 엔터/백스페이스/Delete로 문단(div)을
   직접 나누고 합쳐서 항상 예측 가능한 구조(문단마다 하나의 div)를 유지함. */
function findDirectChildBlock(node){
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  while (el && el.parentNode !== editor) el = el.parentNode;
  return el && el !== editor ? el : null;
}

function splitParagraphAtCaret(){
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  range.deleteContents();

  let blockEl = findDirectChildBlock(range.startContainer);
  if (!blockEl){
    const wrapper = document.createElement('div');
    while (editor.firstChild) wrapper.appendChild(editor.firstChild);
    editor.appendChild(wrapper);
    blockEl = wrapper;
  }

  const newBlock = document.createElement('div');
  if (blockEl.className) newBlock.className = blockEl.className;
  if (blockEl.style && blockEl.style.textAlign) newBlock.style.textAlign = blockEl.style.textAlign;

  const afterRange = document.createRange();
  afterRange.setStart(range.startContainer, range.startOffset);
  afterRange.setEndAfter(blockEl.lastChild || blockEl);
  newBlock.appendChild(afterRange.extractContents());

  if (blockEl.parentNode === editor){
    editor.insertBefore(newBlock, blockEl.nextSibling);
  } else {
    editor.appendChild(newBlock);
  }

  if (!blockEl.hasChildNodes() || blockEl.textContent === ''){
    blockEl.innerHTML = '';
    blockEl.appendChild(document.createElement('br'));
  }
  if (!newBlock.hasChildNodes() || newBlock.textContent === ''){
    newBlock.innerHTML = '';
    newBlock.appendChild(document.createElement('br'));
  }

  const newRange = document.createRange();
  newRange.setStart(newBlock, 0);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
  return newBlock;
}

function mergeParagraphBackward(){
  const selection = window.getSelection();
  if (!selection.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return false;

  const blockEl = findDirectChildBlock(range.startContainer);
  if (!blockEl) return false;

  const preRange = document.createRange();
  preRange.selectNodeContents(blockEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  if (preRange.toString().length !== 0) return false;

  const prevBlock = blockEl.previousElementSibling;
  if (!prevBlock) return false;

  if (prevBlock.childNodes.length === 1 && prevBlock.firstChild.nodeName === 'BR'){
    prevBlock.innerHTML = '';
  }

  const caretMarker = document.createElement('span');
  caretMarker.setAttribute('data-caret-marker', '1');
  prevBlock.appendChild(caretMarker);

  const isEmptyBlock = blockEl.childNodes.length === 1 && blockEl.firstChild.nodeName === 'BR';
  if (!isEmptyBlock){
    while (blockEl.firstChild) prevBlock.appendChild(blockEl.firstChild);
  }
  blockEl.remove();

  const marker = prevBlock.querySelector('[data-caret-marker]');
  if (marker){
    const newRange = document.createRange();
    newRange.setStartBefore(marker);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    marker.remove();
  }
  return true;
}

function mergeParagraphForward(){
  const selection = window.getSelection();
  if (!selection.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return false;

  const blockEl = findDirectChildBlock(range.startContainer);
  if (!blockEl) return false;

  const postRange = document.createRange();
  postRange.selectNodeContents(blockEl);
  postRange.setStart(range.startContainer, range.startOffset);
  if (postRange.toString().length !== 0) return false;

  const nextBlock = blockEl.nextElementSibling;
  if (!nextBlock) return false;

  if (blockEl.childNodes.length === 1 && blockEl.firstChild.nodeName === 'BR'){
    blockEl.innerHTML = '';
  }

  const caretMarker = document.createElement('span');
  caretMarker.setAttribute('data-caret-marker', '1');
  blockEl.appendChild(caretMarker);

  const isEmptyBlock = nextBlock.childNodes.length === 1 && nextBlock.firstChild.nodeName === 'BR';
  if (!isEmptyBlock){
    while (nextBlock.firstChild) blockEl.appendChild(nextBlock.firstChild);
  }
  nextBlock.remove();

  const marker = blockEl.querySelector('[data-caret-marker]');
  if (marker){
    const newRange = document.createRange();
    newRange.setStartBefore(marker);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
    marker.remove();
  }
  return true;
}

editor.addEventListener('keydown', function(e){
  if (isComposingIME) return;

  if (e.key === 'Enter'){
    e.preventDefault();
    splitParagraphAtCaret();
    return;
  }
  if (e.key === 'Backspace'){
    if (mergeParagraphBackward()) e.preventDefault();
    return;
  }
  if (e.key === 'Delete'){
    if (mergeParagraphForward()) e.preventDefault();
  }
});

/* ---------------- 붙여넣기: 서식 제거, 줄마다 새 문단(div)으로 분리해서 삽입 ----------------
   서식이 실린 span 등을 아예 만들지 않고 순수 텍스트 노드/div로만 구성해서 삽입하기 때문에,
   기존처럼 마커를 심어 서식을 되짚어 벗겨내는 과정이 필요 없음. */
function insertPastedText(text){
  editor.focus();
  const lines = text.split(/\r\n|\r|\n/);

  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  let range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  range.deleteContents();

  if (lines.length === 1){
    const textNode = document.createTextNode(lines[0]);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    const firstTextNode = document.createTextNode(lines[0]);
    range.insertNode(firstTextNode);

    let blockEl = findDirectChildBlock(firstTextNode);
    if (!blockEl){
      const wrapper = document.createElement('div');
      while (editor.firstChild) wrapper.appendChild(editor.firstChild);
      editor.appendChild(wrapper);
      blockEl = wrapper;
    }

    let insertAfter = blockEl;
    let lastInsertedNode = firstTextNode;
    for (let i=1; i<lines.length; i++){
      const newDiv = document.createElement('div');
      if (lines[i].length > 0){
        lastInsertedNode = document.createTextNode(lines[i]);
        newDiv.appendChild(lastInsertedNode);
      } else {
        newDiv.appendChild(document.createElement('br'));
        lastInsertedNode = newDiv;
      }
      insertAfter.parentNode.insertBefore(newDiv, insertAfter.nextSibling);
      insertAfter = newDiv;
    }

    const newRange = document.createRange();
    if (lastInsertedNode.nodeType === Node.TEXT_NODE){
      newRange.setStart(lastInsertedNode, lastInsertedNode.length);
    } else {
      newRange.selectNodeContents(lastInsertedNode);
    }
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }
  reapplyParagraphSpacing();
}

editor.addEventListener('paste', (e)=>{
  e.preventDefault();
  const cd = e.clipboardData || window.clipboardData;
  const text = cd ? cd.getData('text/plain') : '';
  if (text){
    insertPastedText(text);
  } else if (navigator.clipboard && navigator.clipboard.readText){
    navigator.clipboard.readText().then(t=>{ if (t) insertPastedText(t); }).catch(()=>{});
  }
});

/* ---------------- 스마트 따옴표 / 말줄임표 / 괄호 ---------------- */
editor.addEventListener('beforeinput', (e)=>{
  if (e.inputType !== 'insertText' || !e.data) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const offset = range.startOffset;
  const before = node.textContent.slice(0, offset);

  if (e.data === '"' && document.getElementById('chkSmartQuote').checked){
    e.preventDefault();
    const isOpen = before.length===0 || /[\s([{“‘]$/.test(before);
    document.execCommand('insertText', false, isOpen ? CH.ldq : CH.rdq);
    return;
  }
  if (e.data === "'" && document.getElementById('chkSmartQuote').checked){
    e.preventDefault();
    const prevChar = before.slice(-1);
    let ch;
    if (/[a-zA-Z0-9가-힣]/.test(prevChar)) ch = CH.rsq; // apostrophe
    else if (before.length===0 || /[\s([{“‘]$/.test(before)) ch = CH.lsq;
    else ch = CH.rsq;
    document.execCommand('insertText', false, ch);
    return;
  }
  if (e.data === '.' && document.getElementById('chkSmartEllipsis').checked){
    if (before.slice(-2) === '..'){
      e.preventDefault();
      const newRange = document.createRange();
      newRange.setStart(node, offset-2);
      newRange.setEnd(node, offset);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(newRange);
      document.execCommand('insertText', false, CH.ellipsis);
      return;
    }
  }
});

editor.addEventListener('input', (e)=>{
  if (document.getElementById('chkBracketColor').checked && e.data === ')'){
    applyBracketColorNearCaret();
  }
  reapplyParagraphSpacing();
});

function applyBracketColorNearCaret(){
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  if (node.parentElement && node.parentElement.classList.contains('paren-auto')) return;
  const text = node.textContent;
  const offset = range.startOffset;
  const upto = text.slice(0, offset);
  const openIdx = upto.lastIndexOf('(');
  const closeIdx = upto.lastIndexOf(')');
  if (openIdx === -1 || openIdx < closeIdx) return;
  const matchClose = offset - 1;
  if (text[matchClose] !== ')') return;
  const color = document.getElementById('colorBracket').value;
  const before = text.slice(0, openIdx);
  const middle = text.slice(openIdx, matchClose+1);
  const after = text.slice(matchClose+1);
  const parent = node.parentNode;
  const beforeNode = document.createTextNode(before);
  const span = document.createElement('span');
  span.className='paren-auto';
  span.style.color = color;
  span.textContent = middle;
  const afterNode = document.createTextNode(after);
  parent.insertBefore(beforeNode, node);
  parent.insertBefore(span, node);
  parent.insertBefore(afterNode, node);
  parent.removeChild(node);
  const newRange = document.createRange();
  newRange.setStart(afterNode, after.length);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

/* 텍스트 노드 안에서 패턴을 찾아 span으로 감싸는 범용 함수 */
function wrapPatternInContainer(container, regex, styleFn, skipClass){
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(n){
      return (skipClass && n.parentElement && n.parentElement.classList.contains(skipClass)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(textNode=>{
    const text = textNode.textContent;
    regex.lastIndex = 0;
    let m; let last = 0; const frag = document.createDocumentFragment(); let found = false;
    while ((m = regex.exec(text))){
      found = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      styleFn(span, m[0]);
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (found){
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  });
}

document.getElementById('btnBracketApplyAll').addEventListener('click', ()=>{
  const color = document.getElementById('colorBracket').value;
  wrapPatternInContainer(editor, /\([^()]*\)/g, (span)=>{ span.className='paren-auto'; span.style.color=color; }, 'paren-auto');
});

/* ---------------- 글자색 (단일) ---------------- */
let mainTextColor = '#000000';
const swatchTextMain = document.getElementById('swatchTextMain');
preventBlur(swatchTextMain);
swatchTextMain.addEventListener('click', ()=> wrapSelectionStyle({color: mainTextColor}));
document.getElementById('colorTextMain').addEventListener('input', (e)=>{
  mainTextColor = e.target.value;
  swatchTextMain.style.background = mainTextColor;
});

/* ---------------- 대사색 (따옴표 안에만 적용) ---------------- */
const dialogueColors = {A:'#c0392b', B:'#2980b9', C:'#27ae60'};
['A','B','C'].forEach(k=>{
  const btn = document.getElementById('btnDialogue'+k);
  preventBlur(btn);
  btn.addEventListener('click', ()=> applyDialogueColor(k));
  const colorInput = document.getElementById('colorDialogue'+k);
  colorInput.addEventListener('input', ()=>{
    dialogueColors[k] = colorInput.value;
    btn.style.color = colorInput.value;
  });
});

function unwrapClassSpans(container, className){
  container.querySelectorAll('span.'+className).forEach(span=>{
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  container.normalize();
}

function getCaretScopeElement(){
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.getRangeAt(0).commonAncestorContainer)) return editor;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === 3) node = node.parentNode;
  while (node && node.parentNode !== editor && node !== editor){ node = node.parentNode; }
  return (node && node !== editor && node.nodeType === 1) ? node : editor;
}

function colorQuotesInContainer(container, color){
  unwrapClassSpans(container, 'dialogue-color');
  wrapPatternInContainer(container, /“[^“”]*”/g, (span)=>{ span.className='dialogue-color'; span.style.color=color; }, null);
}

function colorQuotesInRange(range, color){
  const r = range.cloneRange();
  const extracted = r.extractContents();
  const tempDiv = document.createElement('div');
  tempDiv.appendChild(extracted);
  colorQuotesInContainer(tempDiv, color);
  const frag = document.createDocumentFragment();
  while (tempDiv.firstChild) frag.appendChild(tempDiv.firstChild);
  r.insertNode(frag);
}

function applyDialogueColor(key){
  editor.focus();
  const color = dialogueColors[key];
  const sel = window.getSelection();
  if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer) && !sel.getRangeAt(0).collapsed){
    colorQuotesInRange(sel.getRangeAt(0), color);
  } else {
    const scope = getCaretScopeElement();
    colorQuotesInContainer(scope, color);
  }
}

/* ---------------- 형광펜 ---------------- */
const paletteHi = {A:'#fff59d', B:'#dcdcdc', C:'#ffffff'};
['A','B','C'].forEach(k=>{
  const hswatch = document.querySelector(`[data-apply-hi="${k}"]`);
  preventBlur(hswatch);
  hswatch.addEventListener('click', ()=>{ wrapSelectionStyle({backgroundColor: paletteHi[k]}); });
  const hColorInput = document.getElementById('colorHi'+k);
  hColorInput.addEventListener('input', ()=>{ paletteHi[k]=hColorInput.value; hswatch.style.background = hColorInput.value; });
});
const btnClearHi = document.getElementById('btnClearHi');
preventBlur(btnClearHi);
btnClearHi.addEventListener('click', ()=> wrapSelectionStyle({backgroundColor:'transparent'}));

/* ---------------- 폰트 섹션 ---------------- */
const selectFontFamily = document.getElementById('selectFontFamily');
const rowFontCustom = document.getElementById('rowFontCustom');
const inputFontCustom = document.getElementById('inputFontCustom');

selectFontFamily.addEventListener('change', ()=>{
  if (selectFontFamily.value === 'custom'){
    rowFontCustom.style.display='flex';
    return;
  }
  rowFontCustom.style.display='none';
  state.fontFamily = selectFontFamily.value;
  refreshTextTypography();
});
document.getElementById('btnApplyFontCustom').addEventListener('click', ()=>{
  if (inputFontCustom.value.trim()){
    state.fontFamily = inputFontCustom.value.trim();
    refreshTextTypography();
  }
});

/* 폰트 파일 직접 업로드 (FontFace API) */
let uploadedFontSeq = 0;
document.getElementById('inputFontUpload').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    const fontName = 'uploaded-font-' + (uploadedFontSeq++);
    const displayName = file.name.replace(/\.[^.]+$/, '');
    try{
      const face = new FontFace(fontName, reader.result);
      face.load().then((loaded)=>{
        document.fonts.add(loaded);
        const value = "'" + fontName + "'";
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = displayName + ' (업로드함)';
        selectFontFamily.insertBefore(opt, selectFontFamily.querySelector('option[value="custom"]'));
        selectFontFamily.value = value;
        rowFontCustom.style.display = 'none';
        state.fontFamily = value;
        refreshTextTypography();
      }).catch((err)=>{
        alert('폰트 파일을 불러오지 못했어: ' + err.message);
      });
    } catch(err){
      alert('이 브라우저에서는 폰트 업로드가 지원되지 않아: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  e.target.value = '';
});

function makeStepper(minusId, plusId, inputId, step, min, max, onChange){
  const minus = document.getElementById(minusId);
  const plus = document.getElementById(plusId);
  const input = document.getElementById(inputId);
  function clamp(v){ if (min!==null && v<min) v=min; if (max!==null && v>max) v=max; return v; }
  function commit(v){
    v = clamp(v);
    input.value = v;
    onChange(v);
  }
  minus.addEventListener('click', ()=> commit((parseFloat(input.value)||0) - step));
  plus.addEventListener('click', ()=> commit((parseFloat(input.value)||0) + step));
  input.addEventListener('change', ()=> commit(parseFloat(input.value)||0));
}

/* 장평(가로 압축/확장)의 기준점을 정렬 방식에 맞춰 정함.
   예전엔 항상 왼쪽 위를 기준으로 눌러서, 중앙정렬 텍스트도 장평을 줄일수록
   전체가 왼쪽으로 쏠려 보이는 문제가 있었음. 정렬이 중앙이면 중앙을 기준으로,
   좌측이면 왼쪽, 우측이면 오른쪽을 기준으로 압축/확장되게 해서 박스 자체는 그대로 두고
   글자만 안쪽으로 눌리거나 늘어나 보이게 함 */
function getTrackingOrigin(){
  if (state.align === 'left') return 'left';
  if (state.align === 'right') return 'right';
  return 'center';
}

/* 폰트 섹션(폰트/굵기/크기/자간/행간/장평/정렬/줄바꿈)은 커서 위치나 드래그 선택과 무관하게
   항상 본문 전체에 적용됨. 왼쪽 입력창(bodyEditBox)에는 절대 반영하지 않고, 오른쪽 미리보기의
   본문 텍스트 블록에만 스코프된 스타일 규칙으로 적용해서 HTML 삽입 블록이나 메시지 말풍선은
   이 조정에 영향을 받지 않게 함 */
const textTypographyStyleTag = document.createElement('style');
document.head.appendChild(textTypographyStyleTag);
function refreshTextTypography(){
  textTypographyStyleTag.textContent =
    '#previewContent .preview-block[data-block-id="text"] .block-content{'+
    'font-family:'+state.fontFamily+';'+
    'font-weight:'+state.fontWeight+';'+
    'font-size:'+state.size+'px;'+
    'letter-spacing:'+state.letterSpacing+'px;'+
    'line-height:'+state.lineHeight+'px;'+
    'text-align:'+state.align+';'+
    'word-break:'+state.wordBreak+';'+
    'overflow-wrap:break-word;'+
    'transform:scaleX('+(state.tracking/100)+');'+
    'transform-origin:'+getTrackingOrigin()+';'+
    'display:block;'+
    '}';
}

makeStepper('btnWeightMinus','btnWeightPlus','inputWeight',100,100,900, v=>{ state.fontWeight=v; refreshTextTypography(); });
makeStepper('btnSizeMinus','btnSizePlus','inputSize',5,6,300, v=>{ state.size=v; refreshTextTypography(); });
makeStepper('btnLsMinus','btnLsPlus','inputLs',1,-20,100, v=>{ state.letterSpacing=v; refreshTextTypography(); });
makeStepper('btnLhMinus','btnLhPlus','inputLh',1,0,300, v=>{ state.lineHeight=v; refreshTextTypography(); });
makeStepper('btnParaMinus','btnParaPlus','inputPara',1,0,200, v=>{ state.paragraphSpacing=v; reapplyParagraphSpacing(); });
makeStepper('btnTrackMinus','btnTrackPlus','inputTrack',5,10,300, v=>{ state.tracking=v; refreshTextTypography(); });

/* 문단간격: 커서 위치와 무관하게 본문 전체 문단에 동일하게 적용되도록,
   그리고 왼쪽 입력창에는 반영되지 않게 미리보기의 텍스트 블록에만 스코프된 스타일 규칙으로 처리함 */
const paragraphSpacingStyleTag = document.createElement('style');
document.head.appendChild(paragraphSpacingStyleTag);
function reapplyParagraphSpacing(){
  const px = state.paragraphSpacing + 'px';
  paragraphSpacingStyleTag.textContent =
    '#previewContent .preview-block[data-block-id="text"] .block-content div{margin-bottom:'+px+';}';
}

[['btnAlignLeft','left'],['btnAlignCenter','center'],['btnAlignRight','right'],['btnAlignJustify','justify']].forEach(([id,val])=>{
  const btn = document.getElementById(id);
  preventBlur(btn);
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#btnAlignLeft,#btnAlignCenter,#btnAlignRight,#btnAlignJustify').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.align = val;
    refreshTextTypography();
  });
});

document.getElementById('btnWordNormal').addEventListener('click', ()=>{
  state.wordBreak = 'normal';
  refreshTextTypography();
  document.getElementById('btnWordNormal').classList.add('active');
  document.getElementById('btnWordBreakAll').classList.remove('active');
});
document.getElementById('btnWordBreakAll').addEventListener('click', ()=>{
  state.wordBreak = 'break-all';
  refreshTextTypography();
  document.getElementById('btnWordBreakAll').classList.add('active');
  document.getElementById('btnWordNormal').classList.remove('active');
});

/* ---------------- 미리보기 화면 (zoom, 우측 하단) ---------------- */
function setZoom(v){
  state.zoom = v;
  canvasOuter.style.transform = 'scale('+(v/100)+')';
}
makeStepper('btnZoomMinus','btnZoomPlus','inputZoom',10,10,400, setZoom);

document.getElementById('btnFitZoom').addEventListener('click', ()=>{
  const availW = viewport.clientWidth - 80;
  const availH = viewport.clientHeight - 80;
  const cw = canvas.offsetWidth;
  const ch = canvas.offsetHeight;
  const ratio = Math.min(availW/cw, availH/ch, 2) * 100;
  const v = Math.max(10, Math.round(ratio/5)*5);
  document.getElementById('inputZoom').value = v;
  setZoom(v);
});

/* ---------------- 캔버스 ---------------- */
const RATIO_MULT = {
  '1x1': 1,
  '5x4': 4/5,
  '16x9': 9/16,
  'iphone': 2532/1170
};
const RATIO_BUTTON_IDS = ['btnRatioAuto','btnRatio1x1','btnRatio5x4','btnRatio16x9','btnRatioIphone'];
const RATIO_KEY_MAP = {btnRatioAuto:'auto', btnRatio1x1:'1x1', btnRatio5x4:'5x4', btnRatio16x9:'16x9', btnRatioIphone:'iphone'};

/* 고정 비율 상태에서 본문 내용이 캔버스 높이를 넘으면 자동으로 '자동' 비율로 전환해서 텍스트가 잘리지 않게 함 */
function checkAutoOverflow(){
  if (state.ratio === 'auto') return;
  const neededHeight = previewContent.scrollHeight;
  const fixedHeight = canvas.clientHeight;
  if (fixedHeight > 0 && neededHeight > fixedHeight){
    state.ratio = 'auto';
    RATIO_BUTTON_IDS.forEach(i=>document.getElementById(i).classList.remove('active'));
    document.getElementById('btnRatioAuto').classList.add('active');
    updateCanvasSize();
  }
}

function updateCanvasSize(){
  canvas.style.width = state.width+'px';
  if (state.ratio === 'auto'){
    canvas.style.height = '';
    canvas.style.minHeight = '';
  } else {
    const mult = RATIO_MULT[state.ratio] || 1;
    canvas.style.height = Math.round(state.width*mult)+'px';
  }
  canvasInfo.textContent = state.width + '×' + (state.ratio==='auto' ? 'auto' : parseInt(canvas.style.height));
  checkAutoOverflow();
}

RATIO_BUTTON_IDS.forEach(id=>{
  document.getElementById(id).addEventListener('click', ()=>{
    RATIO_BUTTON_IDS.forEach(i=>document.getElementById(i).classList.remove('active'));
    document.getElementById(id).classList.add('active');
    state.ratio = RATIO_KEY_MAP[id];
    if (id === 'btnRatioIphone'){
      state.width = 1170;
      document.getElementById('inputWidth').value = 1170;
    }
    updateCanvasSize();
  });
});

makeStepper('btnWidthMinus','btnWidthPlus','inputWidth',10,100,2000, v=>{ state.width=v; updateCanvasSize(); });
makeStepper('btnPadXMinus','btnPadXPlus','inputPadX',5,0,500, v=>{ state.padX=v; previewContent.style.paddingLeft=v+'px'; previewContent.style.paddingRight=v+'px'; });
makeStepper('btnPadYMinus','btnPadYPlus','inputPadY',5,0,500, v=>{ state.padY=v; previewContent.style.paddingTop=v+'px'; previewContent.style.paddingBottom=v+'px'; });

/* 배경 모드 (단색 / 이미지) */
const btnBgModeColor = document.getElementById('btnBgModeColor');
const btnBgModeImage = document.getElementById('btnBgModeImage');
const rowBgColor = document.getElementById('rowBgColor');
const rowBgImagePick = document.getElementById('rowBgImagePick');
const rowBgImageSize = document.getElementById('rowBgImageSize');

function setBgMode(mode){
  bgMode = mode;
  btnBgModeColor.classList.toggle('active', mode==='color');
  btnBgModeImage.classList.toggle('active', mode==='image');
  rowBgColor.style.display = mode==='color' ? 'flex' : 'none';
  rowBgImagePick.style.display = mode==='image' ? 'flex' : 'none';
  rowBgImageSize.style.display = (mode==='image' && state.bgImage) ? 'flex' : 'none';
  applyCanvasBackground();
}
btnBgModeColor.addEventListener('click', ()=> setBgMode('color'));
btnBgModeImage.addEventListener('click', ()=> setBgMode('image'));

const colorBg = document.getElementById('colorBg');
const inputBgHex = document.getElementById('inputBgHex');
function setBgColor(hex){
  state.bgColor = hex;
  colorBg.value = hex;
  inputBgHex.value = hex.toUpperCase();
  applyCanvasBackground();
}
colorBg.addEventListener('input', ()=> setBgColor(colorBg.value));
inputBgHex.addEventListener('change', ()=>{
  let v = inputBgHex.value.trim();
  if (!v.startsWith('#')) v = '#'+v;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) setBgColor(v);
});

document.getElementById('inputBgImage').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    state.bgImage = reader.result;
    rowBgImageSize.style.display='flex';
    applyCanvasBackground();
  };
  reader.readAsDataURL(file);
});

function applyCanvasBackground(){
  canvas.style.backgroundColor = state.bgColor;
  canvas.style.setProperty('--tail-mask', state.bgColor);
  if (bgMode==='image' && state.bgImage){
    canvas.style.backgroundImage = `url(${state.bgImage})`;
    canvas.style.backgroundRepeat='no-repeat';
    canvas.style.backgroundPosition='center';
    canvas.style.backgroundSize = state.bgImageSize+'% auto';
  } else {
    canvas.style.backgroundImage='none';
  }
}
makeStepper('btnBgSizeMinus','btnBgSizePlus','inputBgSize',5,10,500, v=>{ state.bgImageSize=v; applyCanvasBackground(); });
document.getElementById('btnRemoveBgImage').addEventListener('click', ()=>{
  state.bgImage = null;
  document.getElementById('inputBgImage').value='';
  rowBgImageSize.style.display='none';
  applyCanvasBackground();
});

/* ---------------- 출처 / 닉네임 표시 (본문 폰트 설정과 완전히 독립) ---------------- */
const sourceLabel = document.getElementById('sourceLabel');
let sourceState = {
  enabled: false,
  text: '',
  position: 'bottom-right', // top-left | top-right | bottom-left | bottom-right
  offsetX: 20,
  offsetY: 20,
  color: '#888888',
  size: 12
};

function renderSourceLabel(){
  if (!sourceState.enabled || !sourceState.text.trim()){
    sourceLabel.style.display = 'none';
    return;
  }
  sourceLabel.style.display = 'block';
  sourceLabel.textContent = sourceState.text;
  sourceLabel.style.color = sourceState.color;
  sourceLabel.style.fontSize = sourceState.size + 'px';
  sourceLabel.style.top = 'auto';
  sourceLabel.style.bottom = 'auto';
  sourceLabel.style.left = 'auto';
  sourceLabel.style.right = 'auto';
  const [vert, horiz] = sourceState.position.split('-');
  sourceLabel.style[vert] = sourceState.offsetY + 'px';
  sourceLabel.style[horiz] = sourceState.offsetX + 'px';
}

document.getElementById('chkSourceEnabled').addEventListener('change', (e)=>{
  sourceState.enabled = e.target.checked;
  renderSourceLabel();
});

const inputSourceText = document.getElementById('inputSourceText');
inputSourceText.addEventListener('input', ()=>{
  sourceState.text = inputSourceText.value;
  renderSourceLabel();
});

['btnSrcBullet1','btnSrcBullet2','btnSrcBullet3','btnSrcBullet4','btnSrcBullet5'].forEach(id=>{
  const btn = document.getElementById(id);
  preventBlur(btn);
  btn.addEventListener('click', ()=>{
    const bullet = btn.dataset.bullet;
    const start = inputSourceText.selectionStart ?? inputSourceText.value.length;
    const end = inputSourceText.selectionEnd ?? inputSourceText.value.length;
    inputSourceText.value = inputSourceText.value.slice(0, start) + bullet + inputSourceText.value.slice(end);
    const pos = start + bullet.length;
    inputSourceText.focus();
    inputSourceText.setSelectionRange(pos, pos);
    sourceState.text = inputSourceText.value;
    renderSourceLabel();
  });
});

const srcPosButtons = {
  'top-left': document.getElementById('btnSrcPosTL'),
  'top-right': document.getElementById('btnSrcPosTR'),
  'bottom-left': document.getElementById('btnSrcPosBL'),
  'bottom-right': document.getElementById('btnSrcPosBR')
};
Object.keys(srcPosButtons).forEach(key=>{
  srcPosButtons[key].addEventListener('click', ()=>{
    sourceState.position = key;
    Object.values(srcPosButtons).forEach(b=>b.classList.remove('active'));
    srcPosButtons[key].classList.add('active');
    renderSourceLabel();
  });
});

makeStepper('btnSrcOffXMinus','btnSrcOffXPlus','inputSrcOffX',5,0,1000, v=>{ sourceState.offsetX=v; renderSourceLabel(); });
makeStepper('btnSrcOffYMinus','btnSrcOffYPlus','inputSrcOffY',5,0,1000, v=>{ sourceState.offsetY=v; renderSourceLabel(); });
makeStepper('btnSrcSizeMinus','btnSrcSizePlus','inputSrcSize',1,6,200, v=>{ sourceState.size=v; renderSourceLabel(); });

document.getElementById('colorSrc').addEventListener('input', (e)=>{
  sourceState.color = e.target.value;
  renderSourceLabel();
});

function applySourceStateToUI(){
  document.getElementById('chkSourceEnabled').checked = sourceState.enabled;
  inputSourceText.value = sourceState.text;
  document.getElementById('inputSrcOffX').value = sourceState.offsetX;
  document.getElementById('inputSrcOffY').value = sourceState.offsetY;
  document.getElementById('inputSrcSize').value = sourceState.size;
  document.getElementById('colorSrc').value = sourceState.color;
  Object.values(srcPosButtons).forEach(b=>b.classList.remove('active'));
  (srcPosButtons[sourceState.position] || srcPosButtons['bottom-right']).classList.add('active');
  renderSourceLabel();
}

/* ---------------- 메시지 (iMessage) - 좌측 박스 목록으로 관리, 본문과 완전히 분리 ---------------- */
const msgColors = {
  left: [{name:'회색', value:'#e5e5ea', text:'#000000'}],
  right: [{name:'파랑', value:'#007aff', text:'#ffffff'}, {name:'회색', value:'#8e8e93', text:'#ffffff'}]
};
function isLight(hex){
  const c = hex.replace('#','');
  const r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  return (r*299+g*587+b*114)/1000 > 150;
}

function escapeHTML(str){
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function insertHTMLAtCursor(html){
  editor.focus();
  restoreSelection();
  const sel = window.getSelection();
  let range;
  if (sel.rangeCount && editor.contains(sel.getRangeAt(0).commonAncestorContainer)){
    range = sel.getRangeAt(0);
  } else {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.deleteContents();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  const frag = document.createDocumentFragment();
  let node, lastNode;
  while ((node = wrapper.firstChild)){ lastNode = frag.appendChild(node); }
  range.insertNode(frag);
  if (lastNode){
    const r2 = document.createRange();
    r2.setStartAfter(lastNode);
    r2.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r2);
    savedRange = null;
  }
  reapplyParagraphSpacing();
  syncPreview();
}

const messageList = document.getElementById('messageList');

/* 아이메시지 말풍선 전용 폰트 설정. 출처처럼 본문 폰트 섹션과 완전히 독립적으로 움직이고,
   말풍선 텍스트에만 적용됨(미리보기의 텍스트 블록/HTML 블록에는 영향 없음) */
let msgFontState = {
  fontFamily: "'Pretendard',-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif",
  weight: 400,
  size: 14,
  letterSpacing: 0
};
const msgFontStyleTag = document.createElement('style');
document.head.appendChild(msgFontStyleTag);
function refreshMsgFontStyle(){
  msgFontStyleTag.textContent =
    '#previewContent .imsg-bubble{'+
    'font-family:'+msgFontState.fontFamily+';'+
    'font-weight:'+msgFontState.weight+';'+
    'font-size:'+msgFontState.size+'px;'+
    'letter-spacing:'+msgFontState.letterSpacing+'px;'+
    '}';
}
const selectMsgFontFamily = document.getElementById('selectMsgFontFamily');
selectMsgFontFamily.addEventListener('change', ()=>{ msgFontState.fontFamily = selectMsgFontFamily.value; refreshMsgFontStyle(); });
makeStepper('btnMsgWeightMinus','btnMsgWeightPlus','inputMsgWeight',100,100,900, v=>{ msgFontState.weight=v; refreshMsgFontStyle(); });
makeStepper('btnMsgSizeMinus','btnMsgSizePlus','inputMsgSize',1,8,100, v=>{ msgFontState.size=v; refreshMsgFontStyle(); });
makeStepper('btnMsgLsMinus','btnMsgLsPlus','inputMsgLs',1,-10,50, v=>{ msgFontState.letterSpacing=v; refreshMsgFontStyle(); });

function applyMsgFontStateToUI(){
  selectMsgFontFamily.value = msgFontState.fontFamily;
  document.getElementById('inputMsgWeight').value = msgFontState.weight;
  document.getElementById('inputMsgSize').value = msgFontState.size;
  document.getElementById('inputMsgLs').value = msgFontState.letterSpacing;
}

function buildMessageHTML(m){
  const list = msgColors[m.side] || msgColors.left;
  const c = list[m.colorIndex] || list[0];
  const bodyText = m.text && m.text.trim() ? escapeHTML(m.text) : '&nbsp;';
  return `<div class="imsg-block"><div class="imsg-row ${m.side}"><div class="imsg-bubble" style="background:${c.value};color:${c.text};">${bodyText}</div></div></div>`;
}
function buildProfileHTML(m){
  return `<div class="imsg-profile-block" style="font-family:${msgFontState.fontFamily};"><img class="imsg-profile-img" src="${m.imgSrc||''}"><div class="imsg-profile-name">${escapeHTML(m.name||'이름 없음')}</div></div>`;
}

function removeMessage(id){
  messages = messages.filter(x=>x.id!==id);
  blocks = blocks.filter(b=>b.id!==id);
  renderMessageBoxes();
  renderPreviewBlocks();
}

function renderMessageBoxes(){
  messageList.innerHTML = '';
  messages.forEach(m=>{
    const box = document.createElement('div');
    box.className = 'msg-box';
    if (m.type === 'message'){
      box.innerHTML = `
        <div class="row">
          <select data-role="side">
            <option value="left">좌</option>
            <option value="right">우</option>
          </select>
          <select data-role="color"></select>
          <input type="color" data-role="newcolor" value="#000000" title="새 색 추가">
          <button class="small" data-role="addcolor">색 추가</button>
          <button class="small" data-role="del" style="margin-left:auto;">삭제</button>
        </div>
        <textarea data-role="text" rows="2" placeholder="말풍선 텍스트"></textarea>
      `;
      const sideSel = box.querySelector('[data-role=side]');
      const colorSel = box.querySelector('[data-role=color]');
      const textArea = box.querySelector('[data-role=text]');
      sideSel.value = m.side;
      textArea.value = m.text || '';
      function refreshColorOptions(){
        colorSel.innerHTML = '';
        msgColors[sideSel.value].forEach((c,i)=>{
          const opt = document.createElement('option');
          opt.value = i; opt.textContent = c.name;
          colorSel.appendChild(opt);
        });
        colorSel.value = Math.min(m.colorIndex, msgColors[sideSel.value].length-1);
      }
      refreshColorOptions();
      sideSel.addEventListener('change', ()=>{
        m.side = sideSel.value; m.colorIndex = 0;
        refreshColorOptions();
        renderPreviewBlocks();
      });
      colorSel.addEventListener('change', ()=>{ m.colorIndex = parseInt(colorSel.value||0); renderPreviewBlocks(); });
      textArea.addEventListener('input', ()=>{ m.text = textArea.value; renderPreviewBlocks(); });
      box.querySelector('[data-role=addcolor]').addEventListener('click', ()=>{
        const hex = box.querySelector('[data-role=newcolor]').value;
        msgColors[sideSel.value].push({name:hex, value:hex, text:isLight(hex)?'#000000':'#ffffff'});
        m.colorIndex = msgColors[sideSel.value].length-1;
        refreshColorOptions();
        renderPreviewBlocks();
      });
      box.querySelector('[data-role=del]').addEventListener('click', ()=> removeMessage(m.id));
    } else {
      box.innerHTML = `
        <div class="row">
          <input type="file" data-role="img" accept="image/*" style="font-size:10px;flex:1;">
          <button class="small" data-role="del">삭제</button>
        </div>
        <input type="text" data-role="name" placeholder="저장된 이름" style="width:100%;">
      `;
      const nameInput = box.querySelector('[data-role=name]');
      nameInput.value = m.name || '';
      nameInput.addEventListener('input', ()=>{ m.name = nameInput.value; renderPreviewBlocks(); });
      box.querySelector('[data-role=img]').addEventListener('change', (e)=>{
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ()=>{ m.imgSrc = reader.result; renderPreviewBlocks(); };
        reader.readAsDataURL(file);
      });
      box.querySelector('[data-role=del]').addEventListener('click', ()=> removeMessage(m.id));
    }
    messageList.appendChild(box);
  });
}

let msgSeq = 0;
document.getElementById('btnAddMessage').addEventListener('click', ()=>{
  const id = 'msg'+(msgSeq++);
  messages.push({id, type:'message', side:'left', colorIndex:0, text:''});
  blocks.push({id, type:'message'});
  renderMessageBoxes();
  renderPreviewBlocks();
});
document.getElementById('btnAddProfile').addEventListener('click', ()=>{
  const id = 'msg'+(msgSeq++);
  messages.push({id, type:'profile', name:'', imgSrc:''});
  blocks.push({id, type:'profile'});
  renderMessageBoxes();
  renderPreviewBlocks();
});

/* ---------------- 미리보기 블록 렌더링 + 드래그 재정렬 ---------------- */
function getDragAfterElement(container, y){
  const els = [...container.querySelectorAll('.preview-block:not(.dragging)')];
  return els.reduce((closest, child)=>{
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height/2;
    if (offset < 0 && offset > closest.offset) return {offset, element:child};
    return closest;
  }, {offset:-Infinity, element:null}).element;
}

previewContent.addEventListener('dragover', (e)=>{
  const dragEl = previewContent.querySelector('.dragging');
  if (!dragEl) return;
  e.preventDefault();
  const afterEl = getDragAfterElement(previewContent, e.clientY);
  if (afterEl == null) previewContent.appendChild(dragEl);
  else previewContent.insertBefore(dragEl, afterEl);
});

function wireBlockDrag(wrap, handle){
  handle.draggable = true;
  handle.addEventListener('dragstart', (e)=>{
    wrap.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try{ e.dataTransfer.setData('text/plain', wrap.dataset.blockId); }catch(err){}
  });
  handle.addEventListener('dragend', ()=>{
    wrap.classList.remove('dragging');
    const newOrder = [...previewContent.querySelectorAll('.preview-block')].map(el=>el.dataset.blockId);
    blocks.sort((a,b)=> newOrder.indexOf(a.id) - newOrder.indexOf(b.id));
  });
}

function renderPreviewBlocks(){
  previewContent.innerHTML = '';
  blocks.forEach(b=>{
    const wrap = document.createElement('div');
    wrap.className = 'preview-block';
    wrap.dataset.blockId = b.id;
    const handle = document.createElement('div');
    handle.className = 'block-handle';
    handle.textContent = '⠿';
    const content = document.createElement('div');
    content.className = 'block-content';
    if (b.type === 'text'){
      content.innerHTML = editor.innerHTML;
    } else if (b.type === 'html'){
      const s = snippets.find(x=>x.id===b.id);
      content.innerHTML = s ? (s.code || '') : '';
    } else {
      const m = messages.find(x=>x.id===b.id);
      if (m){ content.innerHTML = b.type==='profile' ? buildProfileHTML(m) : buildMessageHTML(m); }
    }
    wrap.appendChild(handle);
    wrap.appendChild(content);
    wireBlockDrag(wrap, handle);
    previewContent.appendChild(wrap);
  });
  checkAutoOverflow();
}

/* ---------------- HTML 삽입 (코드별 관리) ---------------- */
let snippets = [];
let snippetSeq = 0;
const snippetList = document.getElementById('snippetList');

function removeSnippet(id){
  snippets = snippets.filter(x=>x.id!==id);
  blocks = blocks.filter(b=>b.id!==id);
  renderSnippets();
  renderPreviewBlocks();
}

function renderSnippets(){
  snippetList.innerHTML='';
  snippets.forEach(s=>{
    const box = document.createElement('div');
    box.className='snippet-box';
    box.innerHTML = `
      <div class="row">
        <input type="text" data-role="name" style="flex:1;" value="${escapeAttr(s.name)}" placeholder="코드 이름">
        <button class="small" data-role="del">삭제</button>
      </div>
      <textarea data-role="code" rows="3" placeholder="HTML 코드 입력"></textarea>
    `;
    box.querySelector('[data-role=name]').addEventListener('input', (e)=>{ s.name = e.target.value; });
    const codeArea = box.querySelector('[data-role=code]');
    codeArea.value = s.code || '';
    codeArea.addEventListener('input', (e)=>{ s.code = e.target.value; renderPreviewBlocks(); });
    box.querySelector('[data-role=del]').addEventListener('click', ()=> removeSnippet(s.id));
    snippetList.appendChild(box);
  });
}
function escapeAttr(str){ return (str||'').replace(/"/g,'&quot;'); }

document.getElementById('btnAddSnippet').addEventListener('click', ()=>{
  const id = 'html'+(snippetSeq++);
  snippets.push({id, name:'코드 '+(snippets.length+1), code:''});
  blocks.push({id, type:'html'});
  renderSnippets();
  renderPreviewBlocks();
});

/* ---------------- 상태 -> UI 반영 ---------------- */
function applyStateToUI(){
  document.getElementById('inputWeight').value = state.fontWeight;
  document.getElementById('inputSize').value = state.size;
  document.getElementById('inputLs').value = state.letterSpacing;
  document.getElementById('inputLh').value = state.lineHeight;
  document.getElementById('inputPara').value = state.paragraphSpacing;
  document.getElementById('inputTrack').value = state.tracking;
  document.getElementById('inputWidth').value = state.width;
  document.getElementById('inputPadX').value = state.padX;
  document.getElementById('inputPadY').value = state.padY;
  document.getElementById('inputZoom').value = state.zoom;
  setBgColor(state.bgColor);

  const fontOpt = [...selectFontFamily.options].find(o=>o.value===state.fontFamily);
  if (fontOpt){ selectFontFamily.value = state.fontFamily; rowFontCustom.style.display='none'; }
  else { selectFontFamily.value = 'custom'; rowFontCustom.style.display='flex'; inputFontCustom.value = state.fontFamily; }

  document.querySelectorAll('#btnAlignLeft,#btnAlignCenter,#btnAlignRight,#btnAlignJustify').forEach(b=>b.classList.remove('active'));
  const alignBtnId = {left:'btnAlignLeft', center:'btnAlignCenter', right:'btnAlignRight', justify:'btnAlignJustify'}[state.align] || 'btnAlignCenter';
  document.getElementById(alignBtnId).classList.add('active');
  document.getElementById('btnWordNormal').classList.toggle('active', state.wordBreak !== 'break-all');
  document.getElementById('btnWordBreakAll').classList.toggle('active', state.wordBreak === 'break-all');

  RATIO_BUTTON_IDS.forEach(i=>document.getElementById(i).classList.remove('active'));
  const activeRatioId = Object.keys(RATIO_KEY_MAP).find(k=>RATIO_KEY_MAP[k]===state.ratio) || 'btnRatioAuto';
  document.getElementById(activeRatioId).classList.add('active');
  updateCanvasSize();
  setZoom(state.zoom);
}

function applyGlobalStyles(){
  refreshTextTypography();
  previewContent.style.paddingLeft = state.padX+'px';
  previewContent.style.paddingRight = state.padX+'px';
  previewContent.style.paddingTop = state.padY+'px';
  previewContent.style.paddingBottom = state.padY+'px';
  reapplyParagraphSpacing();
  refreshMsgFontStyle();
}

applyStateToUI();
applyGlobalStyles();
applySourceStateToUI();
applyMsgFontStateToUI();
syncPreview();

/* ---------------- 저장 (내보내기) ---------------- */
const selectFormat = document.getElementById('selectFormat');
const rowJpegQ = document.getElementById('rowJpegQ');
selectFormat.addEventListener('change', ()=>{
  rowJpegQ.style.display = selectFormat.value==='jpeg' ? 'flex' : 'none';
});

document.getElementById('btnExport').addEventListener('click', async ()=>{
  const btn = document.getElementById('btnExport');
  btn.disabled = true;
  btn.textContent = '내보내는 중...';
  try{
    const format = selectFormat.value;
    const filename = (document.getElementById('inputFileName').value.trim() || 'excerpt');
    const clone = canvas.cloneNode(true);
    clone.querySelectorAll('.block-handle').forEach(h=>h.remove());
    clone.style.transform='none';
    clone.style.position='fixed';
    clone.style.left='-99999px';
    clone.style.top='0';
    if (state.ratio === 'auto'){
      clone.style.height = canvas.scrollHeight + 'px';
    }
    document.body.appendChild(clone);
    const renderedCanvas = await html2canvas(clone, {backgroundColor: format==='jpeg' ? '#ffffff' : null, scale:2, useCORS:true});
    document.body.removeChild(clone);
    const mime = format==='jpeg' ? 'image/jpeg' : 'image/png';
    const quality = format==='jpeg' ? (parseInt(document.getElementById('inputJpegQuality').value||92)/100) : undefined;
    renderedCanvas.toBlob((blob)=>{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename + '.' + (format==='jpeg' ? 'jpg' : 'png');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
    }, mime, quality);
  } catch(err){
    alert('저장 중 오류가 발생했어: '+err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '이미지로 저장';
  }
});

/* ---------------- 섹션 접기/펼치기 ---------------- */
document.querySelectorAll('[data-toggle]').forEach(head=>{
  head.addEventListener('click', ()=>{
    head.parentElement.classList.toggle('collapsed');
  });
});
