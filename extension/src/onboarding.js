// Mesh Sync — Onboarding（MV3 不允許 inline script，所以拆出來）
document.getElementById('copyBtn').addEventListener('click', async () => {
  const text = document.getElementById('snippet').textContent;
  const btn = document.getElementById('copyBtn');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ 已複製，去貼上吧';
  } catch (e) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('snippet'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = '請按 Cmd/Ctrl+C 複製反白文字';
  }
  setTimeout(() => { btn.textContent = '📋 一鍵複製'; }, 3000);
});
