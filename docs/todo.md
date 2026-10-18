# TODO

- [x] Enable context compaction for chats containing images. Preserve original images in saved history and exports, retain recent images in model context, and replace older images with text placeholders alongside the conversation summary. Notify users when older images leave model context. Undo restores the previous context; images can also be reattached.
- [ ] Consider generating image descriptions before compaction and selectively restoring older images to context.
- [ ] Support additional file types as chat attachments. Define supported formats, validation and size limits, content extraction, model compatibility, and persistence/export behavior.
