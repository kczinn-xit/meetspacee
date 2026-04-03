document.getElementById("new-meeting").addEventListener("click", async () => {
  const nameInput = document.getElementById("join-name").value.trim();
  const name = nameInput || "Anonymous";

  const res = await fetch("/api/new-room");
  const data = await res.json();
  window.location.href = `/room/${data.roomId}?name=${encodeURIComponent(name)}`;
});

document.getElementById("join-btn").addEventListener("click", () => {
  const name = document.getElementById("join-name").value.trim();
  const code = document.getElementById("join-code").value.trim().toUpperCase();

  if (!name) {
    document.getElementById("join-name").focus();
    document.getElementById("join-name").style.borderColor = "#e05252";
    return;
  }
  if (!code || code.length < 4) {
    document.getElementById("join-code").focus();
    document.getElementById("join-code").style.borderColor = "#e05252";
    return;
  }

  window.location.href = `/room/${code}?name=${encodeURIComponent(name)}`;
});

// Enter key support on join form
document.getElementById("join-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("join-btn").click();
});
document.getElementById("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("join-btn").click();
  // Auto uppercase as user types
  e.target.value = e.target.value.toUpperCase();
});

// Copy link after room creation
document.getElementById("copy-link").addEventListener("click", async () => {
  const code = document.getElementById("room-code-text").textContent;
  if (!code) return;
  const url = `${window.location.origin}/room/${code}`;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById("copy-link");
    btn.style.color = "#3ecf8e";
    setTimeout(() => (btn.style.color = ""), 1500);
  } catch (e) {
    // Clipboard not available
  }
});
