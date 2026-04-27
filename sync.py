import time
import json
import requests
from typing import Generator

BOOKMARKS_URL = "https://x.com/i/api/graphql/1nFKbANnLDDNT2nyLFZxtQ/Bookmarks"
LIKES_URL_TEMPLATE = "https://x.com/i/api/graphql/{hash}/Likes"
BEARER_TOKEN = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D"
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
REQUEST_DELAY = 0.6
MAX_RETRIES = 3

FEATURES = {
    "rweb_video_screen_enabled": False,
    "rweb_cashtags_enabled": True,
    "profile_label_improvements_pcf_label_in_post_enabled": True,
    "responsive_web_profile_redirect_enabled": False,
    "rweb_tipjar_consumption_enabled": False,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "premium_content_api_read_enabled": False,
    "communities_web_enable_tweet_community_results_fetch": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "responsive_web_grok_analyze_button_fetch_trends_enabled": False,
    "responsive_web_grok_analyze_post_followups_enabled": True,
    "responsive_web_jetfuel_frame": True,
    "responsive_web_grok_share_attachment_enabled": True,
    "responsive_web_grok_annotations_enabled": True,
    "articles_preview_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "content_disclosure_indicator_enabled": True,
    "content_disclosure_ai_generated_indicator_enabled": True,
    "responsive_web_grok_show_grok_translated_post": True,
    "responsive_web_grok_analysis_button_from_backend": True,
    "post_ctas_fetch_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": False,
    "responsive_web_grok_image_annotation_enabled": True,
    "responsive_web_grok_imagine_annotation_enabled": True,
    "responsive_web_grok_community_note_auto_translation_is_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}


def _build_headers(ct0: str, cookie_string: str) -> dict:
    return {
        "Authorization": f"Bearer {BEARER_TOKEN}",
        "Cookie": cookie_string,
        "X-Csrf-Token": ct0,
        "Content-Type": "application/json",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/147.0.0.0 Safari/537.36"
        ),
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "en",
        "x-twitter-active-user": "yes",
        "Referer": "https://x.com/i/bookmarks",
        "Origin": "https://x.com",
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
    }


def _build_params(cursor: str | None = None) -> dict:
    variables: dict = {
        "count": 20,
        "includePromotedContent": True,
    }
    if cursor:
        variables["cursor"] = cursor

    return {
        "variables": json.dumps(variables, separators=(",", ":")),
        "features": json.dumps(FEATURES, separators=(",", ":")),
    }


def _fetch_page(
    session: requests.Session,
    headers: dict,
    cursor: str | None,
    debug: bool = False,
) -> dict:
    params = _build_params(cursor)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(BOOKMARKS_URL, headers=headers, params=params, timeout=30)
            if debug:
                print(f"[debug] HTTP {resp.status_code}  url={resp.url[:120]}")
                print(f"[debug] Response (first 2000 chars):\n{resp.text[:2000]}\n")
            if resp.status_code == 401:
                raise PermissionError(
                    f"Session expired (HTTP 401). Update cookies in .env\n"
                    f"Response: {resp.text[:300]}"
                )
            if resp.status_code == 429:
                wait = 60 * attempt  # 60s, 120s, 180s
                raise RateLimitError(f"Rate limited. Waiting {wait}s before retry.", wait)
            resp.raise_for_status()
            return resp.json()
        except PermissionError:
            raise
        except RateLimitError as e:
            if attempt == MAX_RETRIES:
                raise
            time.sleep(e.wait)
        except requests.RequestException as e:
            if attempt == MAX_RETRIES:
                raise NetworkError(f"Network error after {MAX_RETRIES} retries: {e}") from e
            time.sleep(2 ** attempt)
    return {}


class RateLimitError(Exception):
    def __init__(self, message: str, wait: int):
        super().__init__(message)
        self.wait = wait


class NetworkError(Exception):
    pass


def _extract_media(legacy: dict) -> list[dict]:
    """Extract photos, videos, and GIFs from tweet legacy data."""
    media_items = []
    # extended_entities is more reliable for multi-photo and video
    entities = legacy.get("extended_entities") or legacy.get("entities", {})
    for m in entities.get("media", []):
        media_type = m.get("type", "photo")
        item: dict = {"type": media_type}

        if media_type == "photo":
            item["url"] = m.get("media_url_https", "")

        elif media_type in ("video", "animated_gif"):
            # pick highest-bitrate mp4
            variants = (
                m.get("video_info", {}).get("variants", [])
            )
            mp4s = [v for v in variants if v.get("content_type") == "video/mp4"]
            if mp4s:
                best = max(mp4s, key=lambda v: v.get("bitrate", 0))
                item["url"] = best.get("url", "")
            item["thumb"] = m.get("media_url_https", "")

        if item.get("url"):
            media_items.append(item)
    return media_items


def _extract_tweet(tweet_result: dict) -> dict | None:
    try:
        result = tweet_result.get("result", {})
        if result.get("__typename") == "TweetWithVisibilityResults":
            result = result.get("tweet", {})

        legacy = result.get("legacy", {})
        if not legacy:
            return None

        user_result = (
            result.get("core", {})
            .get("user_results", {})
            .get("result", {})
        )
        user_core = user_result.get("core", {})
        user_legacy = user_result.get("legacy", {})

        tweet_id = legacy.get("id_str") or result.get("rest_id")
        if not tweet_id:
            return None

        full_text = legacy.get("full_text", "")
        # X API v2 puts screen_name/name in user.core; fall back to user.legacy
        author_username = user_core.get("screen_name") or user_legacy.get("screen_name", "unknown")
        author_name = user_core.get("name") or user_legacy.get("name", "unknown")
        created_at_raw = legacy.get("created_at", "")

        created_at = None
        if created_at_raw:
            try:
                from datetime import datetime
                dt = datetime.strptime(created_at_raw, "%a %b %d %H:%M:%S +0000 %Y")
                created_at = dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                created_at = created_at_raw

        url = f"https://x.com/{author_username}/status/{tweet_id}"
        media = _extract_media(legacy)

        views_raw = result.get("views", {}).get("count", "0")
        engagement = {
            "likes":           int(legacy.get("favorite_count", 0) or 0),
            "retweets":        int(legacy.get("retweet_count", 0) or 0),
            "replies":         int(legacy.get("reply_count", 0) or 0),
            "quotes":          int(legacy.get("quote_count", 0) or 0),
            "bookmarks_count": int(legacy.get("bookmark_count", 0) or 0),
            "views":           int(views_raw) if str(views_raw).isdigit() else 0,
        }

        return {
            "id": tweet_id,
            "text": full_text,
            "author_username": author_username,
            "author_name": author_name,
            "created_at": created_at,
            "url": url,
            "media": media,
            "engagement": engagement,
            "raw_json": tweet_result,
        }
    except Exception:
        return None


def _parse_page(data: dict) -> tuple[list[dict], str | None]:
    tweets: list[dict] = []
    next_cursor: str | None = None

    try:
        timeline = (
            data.get("data", {})
            .get("bookmark_timeline_v2", {})
            .get("timeline", {})
        )
        instructions = timeline.get("instructions", [])

        for instruction in instructions:
            if instruction.get("type") == "TimelineAddEntries":
                for entry in instruction.get("entries", []):
                    content = entry.get("content", {})
                    entry_type = content.get("entryType", "")

                    if entry_type == "TimelineTimelineItem":
                        item_content = content.get("itemContent", {})
                        if item_content.get("itemType") == "TimelineTweet":
                            tweet_result = item_content.get("tweet_results", {})
                            tweet = _extract_tweet(tweet_result)
                            if tweet:
                                tweets.append(tweet)

                    elif entry_type == "TimelineTimelineCursor":
                        if content.get("cursorType") == "Bottom":
                            next_cursor = content.get("value")

    except Exception:
        pass

    return tweets, next_cursor


def extract_user_id(cookie_string: str) -> str | None:
    """Parse user ID from twid cookie value (twid=u%3D{id})."""
    import re
    from urllib.parse import unquote
    m = re.search(r'twid=([^;]+)', cookie_string)
    if m:
        val = unquote(m.group(1))  # decodes to u=782326608015360000
        if val.startswith("u="):
            return val[2:]
    return None


def _build_likes_params(user_id: str, cursor: str | None = None) -> dict:
    variables: dict = {
        "userId": user_id,
        "count": 20,
        "includePromotedContent": False,
        "withClientEventToken": False,
        "withBirdwatchNotes": False,
        "withVoice": True,
    }
    if cursor:
        variables["cursor"] = cursor
    return {
        "variables": json.dumps(variables, separators=(",", ":")),
        "features": json.dumps(FEATURES, separators=(",", ":")),
        "fieldToggles": json.dumps({"withArticlePlainText": False}, separators=(",", ":")),
    }


def _parse_likes_page(data: dict) -> tuple[list[dict], str | None]:
    tweets: list[dict] = []
    next_cursor: str | None = None
    try:
        timeline = (
            data.get("data", {})
            .get("user", {})
            .get("result", {})
            .get("timeline", {})
            .get("timeline", {})
        )
        instructions = timeline.get("instructions", [])
        for instruction in instructions:
            if instruction.get("type") == "TimelineAddEntries":
                for entry in instruction.get("entries", []):
                    content = entry.get("content", {})
                    entry_type = content.get("entryType", "")
                    if entry_type == "TimelineTimelineItem":
                        item_content = content.get("itemContent", {})
                        if item_content.get("itemType") == "TimelineTweet":
                            tweet_result = item_content.get("tweet_results", {})
                            tweet = _extract_tweet(tweet_result)
                            if tweet:
                                tweets.append(tweet)
                    elif entry_type == "TimelineTimelineCursor":
                        if content.get("cursorType") == "Bottom":
                            next_cursor = content.get("value")
    except Exception:
        pass
    return tweets, next_cursor


def fetch_all_likes(
    ct0: str,
    cookie_string: str,
    user_id: str,
    likes_hash: str,
    debug: bool = False,
) -> Generator[tuple[list[dict], str | None], None, None]:
    """Yields (tweets_batch, next_cursor) tuples for liked tweets."""
    session = requests.Session()
    headers = _build_headers(ct0, cookie_string)
    url = LIKES_URL_TEMPLATE.format(hash=likes_hash)
    cursor: str | None = None

    while True:
        params = _build_likes_params(user_id, cursor)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = session.get(url, headers=headers, params=params, timeout=30)
                if debug:
                    print(f"[debug] HTTP {resp.status_code}  url={resp.url[:120]}")
                    print(f"[debug] Response (first 2000 chars):\n{resp.text[:2000]}\n")
                if resp.status_code == 401:
                    raise PermissionError(f"Session expired (HTTP 401).\nResponse: {resp.text[:300]}")
                if resp.status_code == 429:
                    wait = 60 * attempt
                    if attempt == MAX_RETRIES:
                        raise RateLimitError(f"Rate limited.", wait)
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                data = resp.json()
                break
            except PermissionError:
                raise
            except RateLimitError:
                raise
            except requests.RequestException as e:
                if attempt == MAX_RETRIES:
                    raise NetworkError(f"Network error: {e}") from e
                time.sleep(2 ** attempt)
        else:
            data = {}

        tweets, next_cursor = _parse_likes_page(data)
        yield tweets, next_cursor
        if not next_cursor or not tweets:
            break
        cursor = next_cursor
        time.sleep(REQUEST_DELAY)


def fetch_all_bookmarks(
    ct0: str,
    cookie_string: str,
    debug: bool = False,
) -> Generator[tuple[list[dict], str | None], None, None]:
    """Yields (tweets_batch, next_cursor) tuples until exhausted."""
    session = requests.Session()
    headers = _build_headers(ct0, cookie_string)
    cursor: str | None = None

    while True:
        try:
            data = _fetch_page(session, headers, cursor, debug=debug)
        except RateLimitError as e:
            # wait out the rate limit then retry the same cursor
            time.sleep(e.wait)
            continue
        tweets, next_cursor = _parse_page(data)
        yield tweets, next_cursor
        if not next_cursor or not tweets:
            break
        cursor = next_cursor
        time.sleep(REQUEST_DELAY)
