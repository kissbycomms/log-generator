"use strict";
/* ---------------- 프리셋 ----------------
   script.js에서 선언한 state, bgMode, mainTextColor, dialogueColors, paletteHi, sourceState,
   swatchTextMain, applyStateToUI, applyGlobalStyles, setBgMode, applySourceStateToUI, syncPreview,
   escapeAttr 등을 그대로 이어받아 사용함. 이 파일은 반드시 script.js보다 나중에 불러와야 함. */

const PRESET_KEY = 'excerptMakerPresets_v1';

function loadPresets(){
  try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch(e){ return []; }
}
function savePresetsToStorage(list){ localStorage.setItem(PRESET_KEY, JSON.stringify(list)); }

function collectSettings(){
  return JSON.parse(JSON.stringify({
    state, bgMode, mainTextColor, dialogueColors, paletteHi, sourceState,
    bracketColor: document.getElementById('colorBracket').value,
    bracketOn: document.getElementById('chkBracketColor').checked,
    smartQuote: document.getElementById('chkSmartQuote').checked,
    smartEllipsis: document.getElementById('chkSmartEllipsis').checked,
    wordBreakAll: document.getElementById('btnWordBreakAll').classList.contains('active')
  }));
}

function applySettings(s){
  state = s.state;
  bgMode = s.bgMode || 'color';
  mainTextColor = s.mainTextColor || '#000000';
  document.getElementById('colorTextMain').value = mainTextColor;
  swatchTextMain.style.background = mainTextColor;
  Object.assign(dialogueColors, s.dialogueColors||{});
  ['A','B','C'].forEach(k=>{
    document.getElementById('colorDialogue'+k).value = dialogueColors[k];
    document.getElementById('btnDialogue'+k).style.color = dialogueColors[k];
  });
  Object.assign(paletteHi, s.paletteHi||{});
  document.getElementById('colorBracket').value = s.bracketColor;
  document.getElementById('chkBracketColor').checked = s.bracketOn;
  document.getElementById('chkSmartQuote').checked = s.smartQuote;
  document.getElementById('chkSmartEllipsis').checked = s.smartEllipsis;
  sourceState = s.sourceState || {enabled:false, text:'', position:'bottom-right', offsetX:20, offsetY:20, color:'#888888', size:12};
  applySourceStateToUI();
  applyStateToUI();
  applyGlobalStyles();
  setBgMode(bgMode);
  if (s.wordBreakAll) document.getElementById('btnWordBreakAll').click(); else document.getElementById('btnWordNormal').click();
  syncPreview();
}

function renderPresets(){
  const list = loadPresets();
  const el = document.getElementById('presetList');
  el.innerHTML='';
  list.forEach((p,i)=>{
    const row = document.createElement('div');
    row.className='preset-row';
    row.innerHTML = `<div class="row"><b style="flex:1;font-size:11.5px;">${escapeAttr(p.name)}</b>
      <button class="small" data-role="apply">적용</button>
      <button class="small" data-role="del">삭제</button></div>`;
    row.querySelector('[data-role=apply]').addEventListener('click', ()=> applySettings(p.settings));
    row.querySelector('[data-role=del]').addEventListener('click', ()=>{
      const l = loadPresets(); l.splice(i,1); savePresetsToStorage(l); renderPresets();
    });
    el.appendChild(row);
  });
}

document.getElementById('btnSavePreset').addEventListener('click', ()=>{
  const nameInput = document.getElementById('inputPresetName');
  const name = nameInput.value.trim();
  if (!name){ alert('프리셋 이름을 입력해줘.'); return; }
  const list = loadPresets();
  list.push({name, settings: collectSettings()});
  savePresetsToStorage(list);
  nameInput.value='';
  renderPresets();
});
renderPresets();
