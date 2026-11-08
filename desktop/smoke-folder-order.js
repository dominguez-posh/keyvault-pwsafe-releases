// #481: in the right-click menu of the list, "Neuer Ordner" / "Neuer Unterordner" comes first, then a separator.
export async function folderFirstCheck({ js, fail }) {
  await js('document.querySelector(".context-menu")?.remove(); true');
  await js('document.querySelector(".list-pane .list")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 400 })); true');
  await new Promise((r) => setTimeout(r, 300));
  const order = await js('[...document.querySelectorAll(".context-menu > *")].slice(0, 2).map((e) => e.className === "context-sep" ? "-" : e.dataset.action)');
  await js('document.querySelector(".context-menu")?.remove(); true');
  if (!Array.isArray(order) || !order.length) return; // no menu on this view
  if (order.includes('new-folder') && (order[0] !== 'new-folder' || order[1] !== '-')) fail('folderorder', `"Neuer Ordner" is not first: ${JSON.stringify(order)}`);
  if (!order.includes('new-folder') && order[0]?.startsWith('new-') && order.length) fail('folderorder', `menu starts with ${order[0]}, expected the folder entry first or no folder entry`);
}
