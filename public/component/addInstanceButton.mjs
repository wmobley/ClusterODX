import { postFetch } from "../common.fetch.js";
import { useState } from "../lib/hooks.module.js";
import { html } from "../lib/preact.html.mjs";
import { AddInstanceDialog } from "./dialog.mjs";

export const AddInstanceButton = ({ getNodes }) => {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const handlerApply = async (props) => {
    const domDialog = props.currentTarget.closest(".modal-dialog");
    if (domDialog) {
      const domhostName = domDialog.querySelector("#hostname");
      const domPort = domDialog.querySelector("#port");
      const domToken = domDialog.querySelector("#token");
      const hostname = domhostName.value;
      const port = Number(domPort.value);
      const token = domToken.value;

      setError("");
      try {
        const response = await postFetch("/r/node/add", {
          body: { hostname, port, token },
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || "Unable to add node.");
        }
        domhostName.value = "";
        domPort.value = "";
        domToken.value = "";
        setOpen(false);
        getNodes();
      } catch (err) {
        setError(err.message || "Unable to add node.");
      }
    }
  };

  return html`<><button classList="btn btn-primary" onClick=${() => setOpen(true)}>Add Node</button>
    <${AddInstanceDialog}
      open=${open}
      error=${error}
      handlerClose=${() => { setOpen(false); setError(""); }}
      handlerApply=${handlerApply}
    ></${AddInstanceDialog}>`;
};
