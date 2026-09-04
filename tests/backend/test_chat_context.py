import contextlib
import io
import json
import unittest
from types import SimpleNamespace
from unittest import mock

from backend.context import AppContext
from backend.http import Request
from backend.routes import chat
from backend.services import chat_context


class ChatContextTests(unittest.TestCase):
    target = {"host": "127.0.0.1", "port": 8080, "source": "runtime"}

    def measure(self, tokens=100, capacity=4096, limit=-1, body=None):
        with mock.patch.object(chat_context, "_read_json", side_effect=[
            {"default_generation_settings": {"n_ctx": capacity, "params": {"n_predict": limit}}, "total_slots": 4},
            {"input_tokens": tokens},
        ]):
            return chat_context.measure(body or {}, self.target)

    def test_capacity_is_per_slot_and_reserves_requested_or_server_limit(self):
        measured = self.measure(body={"max_tokens": 512})
        self.assertEqual((measured["capacity"], measured["remaining"]), (4096, 3484))
        self.assertEqual(measured["reserve_source"], "request")
        self.assertEqual(self.measure(limit=256)["reply_reserve"], 256)
        self.assertEqual(self.measure(body={"max_tokens": 0})["reply_reserve"], 0)

    def test_boundaries_and_unlimited_planning_reserve(self):
        self.assertEqual(self.measure(tokens=3584, body={"max_tokens": 512})["status"], "warning")
        self.assertEqual(self.measure(tokens=3585, body={"max_tokens": 512})["status"], "overflow")
        self.assertEqual(self.measure(tokens=4096, body={"max_tokens": 0})["status"], "overflow")
        unlimited = self.measure(tokens=4000)
        self.assertEqual(unlimited["status"], "warning")
        self.assertEqual(unlimited["reserve_source"], "planning")
        self.assertEqual(self.measure(tokens=4096)["status"], "overflow")

    def test_template_fallback_preserves_options_reasoning_and_special_tokens(self):
        body = {"model": "model name", "messages": [{"role": "assistant", "content": "answer", "reasoning_content": "thought"}],
                "chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": "high", "web_search": True}
        with mock.patch.object(chat_context, "_read_json", side_effect=[
            {"default_generation_settings": {"n_ctx": 4096}}, None,
            {"prompt": "<bos>thought answer<assistant>"}, {"tokens": [1, 2, 3]},
        ]) as read:
            budget = chat_context.measure(body, self.target, "Bearer secret")
        self.assertEqual(budget["prompt_tokens"], 3)
        self.assertEqual(read.call_args_list[0].args[2], "/props?model=model+name")
        formatted = read.call_args_list[2].args[3]
        self.assertEqual(formatted["messages"], body["messages"])
        self.assertEqual(formatted["chat_template_kwargs"], body["chat_template_kwargs"])
        self.assertNotIn("web_search", formatted)
        token_body = read.call_args_list[3].args[3]
        self.assertTrue(token_body["add_special"])
        self.assertTrue(token_body["parse_special"])
        self.assertEqual(body["web_search"], True)

    def test_missing_malformed_and_failed_counts_remain_unknown(self):
        cases = [None, {}, {"default_generation_settings": {"n_ctx": 0}}]
        for props in cases:
            with self.subTest(props=props), mock.patch.object(chat_context, "_read_json", return_value=props):
                self.assertEqual(chat_context.measure({}, self.target)["status"], "unavailable")
        for tokens in (None, True, -1, "100"):
            self.assertEqual(self.measure(tokens=tokens)["status"], "unavailable")
        with mock.patch.object(chat_context, "_read_json", side_effect=TimeoutError("private path")), contextlib.redirect_stderr(io.StringIO()) as log:
            result = chat_context.measure({}, self.target)
        self.assertIn("private path", log.getvalue())
        self.assertNotIn("private path", result["message"])

    def test_media_never_uses_text_only_fallback(self):
        with mock.patch.object(chat_context, "_read_json", side_effect=[
            {"default_generation_settings": {"n_ctx": 4096}}, None,
        ]) as read:
            result = chat_context.measure({"messages": [{"content": [{"type": "image_url"}]}]}, self.target)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(result["status"], "unavailable")

    def test_pinned_requests_use_selected_target_auth_and_do_not_follow_errors(self):
        upstream = mock.MagicMock(status=200)
        upstream.__enter__.return_value = upstream
        upstream.read.return_value = b'{"input_tokens": 2}'
        with mock.patch.object(chat_context, "open_pinned_local_request", return_value=upstream) as opened:
            self.assertEqual(chat_context._read_json(self.target, "Bearer key", "/tokenize", {"content": "x"}), {"input_tokens": 2})
        self.assertEqual(opened.call_args.args, ("127.0.0.1", 8080, "/tokenize"))
        self.assertEqual(opened.call_args.kwargs["headers"]["Authorization"], "Bearer key")
        upstream.status = 404
        with mock.patch.object(chat_context, "open_pinned_local_request", return_value=upstream):
            self.assertIsNone(chat_context._read_json(self.target, "", "/tokenize"))

    def test_preview_uses_authoritative_target_and_marks_search_pending(self):
        response = SimpleNamespace(json=mock.Mock())
        with mock.patch.object(chat.external_server, "resolve_llama_target", return_value=self.target), \
             mock.patch.object(chat.external_server, "resolve_llama_authorization", return_value="Bearer active"), \
             mock.patch.object(chat_context, "measure", return_value={"status": "ok"}) as measure:
            chat.context_budget(Request("POST", "/api/chat/context", "", {}, body={"host": "remote", "web_search": True}), response, AppContext())
        self.assertEqual(measure.call_args.args[1:], (self.target, "Bearer active"))
        self.assertTrue(response.json.call_args.args[0]["search_pending"])

    def test_final_check_includes_injected_search_and_prevents_inference(self):
        response = SimpleNamespace(sse_headers=mock.Mock(), handler=SimpleNamespace(wfile=io.BytesIO(), close_connection=False))
        body = {"messages": [{"role": "system", "content": "Instructions"}, {"role": "user", "content": "Question"}], "web_search": True}
        with mock.patch.object(chat.external_server, "resolve_llama_target", return_value=self.target), \
             mock.patch.object(chat.external_server, "resolve_llama_authorization", return_value="Bearer active"), \
             mock.patch.object(chat.web_search, "web_search", return_value={"ok": True, "results": [{"url": "https://example.com", "snippet": "Search material"}]}), \
             mock.patch.object(chat.web_search, "fetch_page_text", return_value={"ok": True, "text": "Full search material"}), \
             mock.patch.object(chat_context, "measure", return_value={"status": "overflow", "message": "Context limit exceeded"}) as measure, \
             mock.patch.object(chat, "open_pinned_local_request") as inference:
            chat.completions(Request("POST", "/api/chat/completions", "", {}, body=body), response, AppContext())
        counted_body = measure.call_args.args[0]
        self.assertIn("Instructions", counted_body["messages"][0]["content"])
        self.assertIn("Full search material", counted_body["messages"][0]["content"])
        self.assertNotIn("web_search", counted_body)
        self.assertEqual(body["messages"][0]["content"], "Instructions")
        inference.assert_not_called()
        frames = response.handler.wfile.getvalue().decode()
        self.assertIn('"type": "context_budget"', frames)
        self.assertIn('"includes_search": true', frames)
        self.assertIn("Context limit exceeded", frames)
        self.assertTrue(response.handler.close_connection)
