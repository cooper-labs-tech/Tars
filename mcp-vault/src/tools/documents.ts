import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";
import { callerName, getCallerIdentity } from "../../../mcp-shared/src/tars-api.js";

interface VaultDocument {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  author: string;
  agent_id: string | null;
  tags: string;
  created_at: string;
  updated_at: string;
}

interface VaultFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Find an existing folder by name (case-insensitive) or create a new one.
 */
async function resolveFolder(folderName: string): Promise<string> {
  const result = await apiRequest("GET", "/api/vault/folders") as { folders: VaultFolder[] };
  const match = result.folders.find(
    f => f.name.toLowerCase() === folderName.toLowerCase()
  );
  if (match) return match.id;

  // No match: create a new folder at root level
  const created = await apiRequest("POST", "/api/vault/folders", {
    name: folderName,
  }) as { success: boolean; folder: VaultFolder };
  return created.folder.id;
}

export function registerDocumentTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "vault_create_document",
      description: "Create a new document in the Vault. Use this to write reports, analyses, research findings, or any structured knowledge. You MUST specify a folder name: the document will be placed in an existing folder with that name, or a new folder will be created automatically.",
      schema: {
        title: z.string().describe("Document title"),
        content: z.string().describe("Document content (supports Markdown)"),
        folder: z.string().describe("Folder name to organize the document into (e.g. 'Twitter Research', 'Weekly Reports', 'Competitor Analysis'). If a folder with this name exists it will be used, otherwise a new folder is created."),
        tags: z.array(z.string()).optional().describe("Tags for categorization (e.g. ['report', 'weekly', 'competitor'])"),
      },
      failure: "creating document",
      async run({ title, content, folder, tags }) {
        // The caller's, from its shared call or its environment (tars-api.ts).
        const author = callerName() || "agent";
        const agent_id = getCallerIdentity().agentId || undefined;

        // Resolve folder name to ID (find existing or create new)
        const folder_id = await resolveFolder(folder);

        const result = await apiRequest("POST", "/api/vault/documents", {
          title,
          content,
          folder_id,
          author,
          agent_id,
          tags,
        }) as { success: boolean; document: VaultDocument };

        return text(`Document created successfully!\nID: ${result.document.id}\nTitle: ${result.document.title}\nFolder: ${folder}\nTags: ${tags?.join(", ") || "None"}`);
      },
    }),

    tool({
      name: "vault_update_document",
      description: "Update an existing document in the Vault.",
      schema: {
        document_id: z.string().describe("The document ID to update"),
        title: z.string().optional().describe("New title"),
        content: z.string().optional().describe("New content (replaces entire content)"),
        tags: z.array(z.string()).optional().describe("New tags (replaces existing tags)"),
        folder_id: z.string().optional().describe("Move to a different folder"),
      },
      failure: "updating document",
      async run({ document_id, title, content, tags, folder_id }) {
        const body: Record<string, unknown> = {};
        if (title !== undefined) body.title = title;
        if (content !== undefined) body.content = content;
        if (tags !== undefined) body.tags = tags;
        if (folder_id !== undefined) body.folder_id = folder_id;

        const result = await apiRequest("PUT", `/api/vault/documents/${document_id}`, body) as { success: boolean; document: VaultDocument };

        return text(`Document updated successfully!\nID: ${result.document.id}\nTitle: ${result.document.title}`);
      },
    }),

    tool({
      name: "vault_get_document",
      description: "Read a document from the Vault.",
      schema: {
        document_id: z.string().describe("The document ID to read"),
      },
      failure: "reading document",
      async run({ document_id }) {
        const result = await apiRequest("GET", `/api/vault/documents/${document_id}`) as {
          document: VaultDocument;
          attachments: Array<{ id: string; filename: string; mimetype: string; size: number }>;
        };

        const doc = result.document;
        const tags = JSON.parse(doc.tags || "[]");
        const attachmentList = result.attachments.length > 0
          ? `\nAttachments:\n${result.attachments.map(a => `  - ${a.filename} (${a.mimetype}, ${a.size} bytes)`).join("\n")}`
          : "";

        return text(`Title: ${doc.title}\nID: ${doc.id}\nAuthor: ${doc.author}\nFolder: ${doc.folder_id || "Root"}\nTags: ${tags.join(", ") || "None"}\nCreated: ${doc.created_at}\nUpdated: ${doc.updated_at}${attachmentList}\n\n---\n\n${doc.content}`);
      },
    }),

    tool({
      name: "vault_list_documents",
      description: "List documents in the Vault. Optionally filter by folder or tags.",
      schema: {
        folder_id: z.string().optional().describe("Filter by folder ID"),
        tags: z.array(z.string()).optional().describe("Filter by tags (matches any)"),
      },
      failure: "listing documents",
      async run({ folder_id, tags }) {
        let path = "/api/vault/documents";
        const params: string[] = [];
        if (folder_id) params.push(`folder_id=${encodeURIComponent(folder_id)}`);
        if (tags && tags.length > 0) params.push(`tags=${encodeURIComponent(tags.join(","))}`);
        if (params.length > 0) path += `?${params.join("&")}`;

        const result = await apiRequest("GET", path) as { documents: VaultDocument[] };

        if (result.documents.length === 0) {
          return text("No documents found.");
        }

        const summary = result.documents.map(d => {
          const docTags = JSON.parse(d.tags || "[]");
          return `- [${d.id.slice(0, 8)}] ${d.title} (by ${d.author}, ${d.updated_at.slice(0, 10)}${docTags.length > 0 ? `, tags: ${docTags.join(", ")}` : ""})`;
        }).join("\n");

        return text(`Found ${result.documents.length} document(s):\n${summary}`);
      },
    }),

    tool({
      name: "vault_delete_document",
      description: "Delete a document from the Vault.",
      schema: {
        document_id: z.string().describe("The document ID to delete"),
      },
      failure: "deleting document",
      async run({ document_id }) {
        await apiRequest("DELETE", `/api/vault/documents/${document_id}`);
        return text(`Document ${document_id} deleted successfully.`);
      },
    }),

    tool({
      name: "vault_attach_file",
      description: "Attach a file to a Vault document.",
      schema: {
        document_id: z.string().describe("The document ID to attach the file to"),
        file_path: z.string().describe("Absolute path to the file to attach"),
      },
      failure: "attaching file",
      async run({ document_id, file_path }) {
        const result = await apiRequest("POST", `/api/vault/documents/${document_id}/attach`, {
          file_path,
        }) as { success: boolean; attachment: { id: string; filename: string; mimetype: string; size: number } };

        return text(`File attached successfully!\nAttachment ID: ${result.attachment.id}\nFilename: ${result.attachment.filename}\nType: ${result.attachment.mimetype}\nSize: ${result.attachment.size} bytes`);
      },
    }),
  ]);
}
