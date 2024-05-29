import express from "express";
import fetch from "node-fetch";

// TODO: Navigating to __mocks__ shouldn't be needed.
import { browser, messenger } from "../__mocks__/browser";
// @ts-ignore
global.browser = browser;
// @ts-ignore
global.messenger = messenger;

import {
  getAndProcessMessages,
  handleContextMenu,
  handleHotkey,
  handleMenuButton,
  onlyWhitespace,
  processMail,
  renderString,
} from "../src/background";

// Replace the javascript fetch with nodejs fetch.
// @ts-ignore
global.fetch = jest.fn(fetch);

// Simple test server. Will receive the request that should go to Joplin.
let app = express();
let server: any;
let requests: any;

// Capture all console output.
console.log = <jest.Mock>jest.fn();
console.warn = <jest.Mock>jest.fn();
console.error = <jest.Mock>jest.fn();

// https://dev.to/chrismilson/zip-iterator-in-typescript-ldm
type Iterableify<T> = { [K in keyof T]: Iterable<T[K]> };
function* zip<T extends Array<any>>(...toZip: Iterableify<T>): Generator<T> {
  // Get iterators for all of the iterables.
  const iterators = toZip.map((i) => i[Symbol.iterator]());

  while (true) {
    // Advance all of the iterators.
    const results = iterators.map((i) => i.next());

    // If any of the iterators are done, we should stop.
    if (results.some(({ done }) => done)) {
      break;
    }

    // We can assert the yield type, since we know none
    // of the iterators are done.
    yield results.map(({ value }) => value) as T;
  }
}

const expectConsole = (expected: { [Key: string]: Array<string> | number }) => {
  // Check whether the console output is as expected.

  for (const [method, lengthOrContent] of Object.entries(expected)) {
    // @ts-ignore
    const actual = <Array<Array<String>>>console[method].mock.calls;
    if (typeof lengthOrContent === "number") {
      // Only check number of calls.
      expect(actual.length).toBe(lengthOrContent);
    } else {
      // Check content of calls.
      for (const [actualOutput, expectedOutput] of zip(
        actual,
        lengthOrContent
      )) {
        expect(actualOutput[0]).toBe(expectedOutput);
      }
    }
  }
};

beforeAll(() => {
  // https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener
  server = app.listen(41142);
  app.use(express.json()); // allow easy access of request.body

  // TODO: How to flexibly assign and delete routes/middlewares?
  // https://stackoverflow.com/a/28369539/7410886
  app.use((req, res, next) => {
    requests.push(req);

    if (req.query.token !== "validToken") {
      res.status(401).send("Invalid token");
    }

    let returnData: any;
    switch (req.path) {
      case "/notes":
        // console.log(req.body);
        returnData = { items: [] };
        break;
      case "/resources":
        returnData = { items: [] };
        break;
      case "/search":
        if (req.query.type === "tag") {
          switch (req.query.query) {
            case "existentTag":
              returnData = { items: [{ id: "arbitraryId" }] };
              break;
            case "multipleTags":
              returnData = {
                items: [
                  { id: "arbitraryId1", title: "a" },
                  { id: "arbitraryId2", title: "b" },
                ],
              };
              break;
            default:
              returnData = { items: [] };
          }
        }
        break;
      case "/tags":
        if (req.body.title.trim() !== req.body.title) {
          res
            .status(500)
            .send(
              "Tag shouldn't start or end with whitespaces. " +
                "They get stripped by Joplin, which can lead to inconsistent behaviour."
            );
        }
        returnData = { items: [] };
        break;
      default:
      //console.log(req.path);
    }

    if (req.method === "PUT" && req.path.startsWith("/notes")) {
      returnData = { items: [] };
    }

    res.status(200).send(JSON.stringify(returnData));
  });
});

beforeEach(() => {
  jest.clearAllMocks();

  // TODO: How to reset the object properly?
  browser.notifications.icon = undefined;
  browser.notifications.title = undefined;
  browser.notifications.message = undefined;
  browser.browserAction.icon = undefined;

  // Set local storage to mostly default values.
  browser.storage.local.data = {
    joplinScheme: "http",
    joplinHost: "127.0.0.1",
    joplinPort: 41142,
    joplinToken: "validToken",

    joplinShowNotifications: "onFailure",

    joplinSubjectTrimRegex: "",
    joplinAuthorTrimRegex: "",
    joplinDateFormat: "",
    joplinNoteTitleTemplate: "{{subject}} from {{author}}",
    joplinNoteHeaderTemplate: "",
    joplinNoteParentFolder: "arbitrary folder",
    joplinNoteFormat: "text/html",
    joplinExportAsTodo: false,
    // Try to keep the tests minimal.
    joplinNoteTags: "",
    joplinNoteTagsFromEmail: false,
    joplinAttachments: "ignore",
  };
  requests = [];
});

afterAll(() => {
  server.close();
});

describe("handle button / hotkey / context menu", () => {
  test("API token not set", async () => {
    await browser.storage.local.set({ joplinToken: undefined });

    await getAndProcessMessages({ id: 0 }, {});
    expect(browser.notifications.icon).toBe("../images/logo_96_red.png");
    expect(browser.notifications.title).toBe("Joplin export failed");
    expect(browser.notifications.message).toBe("API token missing.");

    expectConsole({
      log: 0,
      warn: 0,
      error: 0,
    });
  });

  test("invalid API token", async () => {
    await browser.storage.local.set({ joplinToken: "invalidToken" });
    browser.messageDisplay.getDisplayedMessages.mockResolvedValueOnce([
      { id: 0 },
    ]);
    await getAndProcessMessages({ id: 0 }, {});

    expect(browser.notifications.icon).toBe("../images/logo_96_red.png");
    expect(browser.notifications.title).toBe("Joplin export failed");
    expect(browser.notifications.message).toBe(
      "Please check the developer console."
    );

    expectConsole({
      log: 1,
      warn: 0,
      error: ["Failed to create note: Invalid token"],
    });
  });

  test.each`
    showNotificationsSetting | exportSuccessful | notificationShown
    ${"always"}              | ${true}          | ${true}
    ${"always"}              | ${false}         | ${true}
    ${"onSuccess"}           | ${true}          | ${true}
    ${"onSuccess"}           | ${false}         | ${false}
    ${"onFailure"}           | ${true}          | ${false}
    ${"onFailure"}           | ${false}         | ${true}
    ${"never"}               | ${true}          | ${false}
    ${"never"}               | ${false}         | ${false}
  `(
    "show notifications setting: $showNotificationsSetting | export success: $exportSuccessful | notification shown: $notificationShown",
    async ({
      showNotificationsSetting,
      exportSuccessful,
      notificationShown,
    }) => {
      await browser.storage.local.set({
        joplinShowNotifications: showNotificationsSetting,
      });

      // "{ id: 0 }" yields a successful export.
      // "null" triggers the error "Mail header is empty".
      browser.messageDisplay.getDisplayedMessages.mockResolvedValueOnce(
        exportSuccessful ? [{ id: 0 }] : [null]
      );

      await getAndProcessMessages({ id: 0 }, {});

      // Check the notification.
      let expectedResult = {
        icon: <string | undefined>undefined,
        title: <string | undefined>undefined,
        message: <string | undefined>undefined,
      };
      if (notificationShown) {
        if (exportSuccessful) {
          expectedResult = {
            icon: "../images/logo_96_blue.png",
            title: "Joplin export succeeded",
            message: "Exported one email.",
          };
        } else {
          expectedResult = {
            icon: "../images/logo_96_red.png",
            title: "Joplin export failed",
            message: "Please check the developer console.",
          };
        }
      }
      expect(browser.notifications).toEqual(
        expect.objectContaining(expectedResult)
      );

      expectConsole({
        log: exportSuccessful ? 1 : 0,
        warn: 0,
        error: exportSuccessful ? 0 : 1,
      });
    }
  );

  test("export by menu button", async () => {
    messenger.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    browser.messageDisplay.getDisplayedMessages.mockReturnValueOnce([
      { id: 1 },
    ]);

    await handleMenuButton({ id: 1 }, { menuItemId: "export_to_joplin" });

    expect(requests.length).toBe(1);
    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });

  test("export by hotkey", async () => {
    messenger.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    browser.messageDisplay.getDisplayedMessages.mockReturnValueOnce([
      { id: 1 },
    ]);

    await handleHotkey("export_to_joplin");

    expect(requests.length).toBe(1);
    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });

  test("export by context menu", async () => {
    messenger.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    browser.messageDisplay.getDisplayedMessages.mockReturnValueOnce([
      { id: 1 },
    ]);

    await handleContextMenu({ menuItemId: "export_to_joplin" }, { id: 1 });

    expect(requests.length).toBe(1);
    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });
});

describe("process mail", () => {
  test("empty header", async () => {
    const result = await processMail(undefined);
    expect(result).toBe("Mail header is empty");

    expectConsole({
      log: 0,
      warn: 0,
      error: 0,
    });
  });

  test("undefined body", async () => {
    browser.messages.getFull.mockResolvedValueOnce(undefined);

    // Arbitrary id, since we mock the mail anyway.
    const result = await processMail({ id: 0 });
    expect(result).toBe("Mail body is empty");

    expectConsole({
      log: 0,
      warn: 0,
      error: 0,
    });
  });

  test("empty body", async () => {
    browser.messages.getFull.mockResolvedValueOnce({});

    const result = await processMail({ id: 0 });
    expect(result).toBe("Mail body is empty");

    expectConsole({
      log: 0,
      warn: 0,
      error: 0,
    });
  });

  test("add header info", async () => {
    const subject = "test subject";
    const author = "test author";
    const date = new Date("1995-12-17T03:24:00");
    const recipients = ["recipient 1", "recipient 2"];
    const body = "test body";

    await browser.storage.local.set({
      joplinNoteHeaderTemplate: `
        From: {{author}}
        Subject: {{subject}}
        Date: {{date}}
        To: {{recipients}}

        ---

    `,
    });

    browser.helper.getSelectedText.mockResolvedValueOnce(body);

    const result = await processMail({
      id: 1,
      subject: subject,
      author: author,
      date: date,
      recipients: recipients,
    });

    expect(result).toBe(null);
    // 1 request to create the note.
    // 1 request to add the header info.
    expect(requests.length).toBe(2);
    for (const info of [
      subject,
      author,
      date.toString(),
      recipients[0],
      recipients[1],
    ]) {
      expect(requests[1].body.body).toContain(info);
    }
    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });

  test.each`
    preferredFormat | htmlAvailable | plainAvailable | resultFormat
    ${"text/html"}  | ${false}      | ${false}       | ${null}
    ${"text/html"}  | ${false}      | ${true}        | ${"text/plain"}
    ${"text/html"}  | ${true}       | ${false}       | ${"text/html"}
    ${"text/html"}  | ${true}       | ${true}        | ${"text/html"}
    ${"text/plain"} | ${false}      | ${false}       | ${null}
    ${"text/plain"} | ${false}      | ${true}        | ${"text/plain"}
    ${"text/plain"} | ${true}       | ${false}       | ${"text/html"}
    ${"text/plain"} | ${true}       | ${true}        | ${"text/plain"}
  `(
    "preferred: $preferredFormat | available: html: $htmlAvailable, plain: $plainAvailable | result: $resultFormat",
    async ({
      preferredFormat,
      htmlAvailable,
      plainAvailable,
      resultFormat,
    }) => {
      const subject = "test subject";
      const author = "test author";
      const date = new Date(Date.now());
      const body = "test body";

      await browser.storage.local.set({ joplinNoteFormat: preferredFormat });

      browser.messages.getFull.mockResolvedValueOnce({
        parts: [
          {
            contentType: "text/html",
            body: htmlAvailable ? body : "",
            parts: [],
          },
          {
            contentType: "text/plain",
            body: plainAvailable ? body : "",
            parts: [],
          },
        ],
      });

      const result = await processMail({
        id: 0,
        subject: subject,
        author: author,
        date: date,
      });

      if (!resultFormat) {
        expect(result).toBe("Mail body is empty");
        return;
      }

      expect(result).toBe(null);
      expect(requests.length).toBe(1);
      expect(requests[0].method).toBe("POST");
      expect(requests[0].url).toBe(
        `/notes?fields=id,body&token=${browser.storage.local.data.joplinToken}`
      );
      const expectedKey = resultFormat === "text/html" ? "body_html" : "body";
      expect(requests[0].body).toEqual({
        [expectedKey]: body,
        parent_id: browser.storage.local.data.joplinNoteParentFolder,
        title: `${subject} from ${author}`,
        is_todo: 0,
        author: author,
        user_created_time: date.getTime(),
      });

      // Finally check the console output.
      const message =
        resultFormat === "text/html"
          ? "Sending complete email in HTML format."
          : "Sending complete email in plain format.";
      expectConsole({
        log: [message],
        warn: 0,
        error: 0,
      });
    }
  );

  test("export selection", async () => {
    const subject = "test subject";
    const author = "test author";
    const date = new Date(Date.now());
    const body = "test body";

    browser.helper.getSelectedText.mockResolvedValueOnce(body);

    const result = await processMail({
      id: 0,
      subject: subject,
      author: author,
      date: date,
    });
    expect(result).toBe(null);

    expect(requests.length).toBe(1);
    expect(requests[0].body).toEqual({
      body: body,
      parent_id: browser.storage.local.data.joplinNoteParentFolder,
      title: `${subject} from ${author}`,
      is_todo: 0,
      author: author,
      user_created_time: date.getTime(),
    });

    expectConsole({
      log: ["Sending selection in plain format."],
      warn: 0,
      error: 0,
    });
  });

  test("export as todo", async () => {
    await browser.storage.local.set({ joplinExportAsTodo: true });

    const result = await processMail({ id: 0 });

    expect(result).toBe(null);
    expect(requests.length).toBe(1);
    expect(requests[0].body).toEqual(expect.objectContaining({ is_todo: 1 }));

    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });

  test.each`
    inputSubject                         | regexString                          | expectedSubject
    ${"Re: Re: Fwd:[topic] subject Re:"} | ${""}                                | ${"Re: Re: Fwd:[topic] subject Re:"}
    ${"Re: Re: Fwd:[topic] subject Re:"} | ${"^(((Re|Fw|Fwd):|(\\[.*\\])) ?)*"} | ${"subject Re:"}
  `(
    "modify subject by regex: $regexString",
    async ({ inputSubject, regexString, expectedSubject }) => {
      const author = "author name";
      await browser.storage.local.set({ joplinSubjectTrimRegex: regexString });

      const result = await processMail({
        id: 1,
        subject: inputSubject,
        author: author,
      });

      expect(result).toBe(null);
      expect(requests.length).toBe(1);
      expect(requests[0].body).toEqual(
        expect.objectContaining({ title: `${expectedSubject} from ${author}` })
      );

      expectConsole({
        log: 1,
        warn: 0,
        error: 0,
      });
    }
  );

  test.each`
    inputAuthor                    | regexString  | expectedAuthor
    ${"John Doof <john@doof.com>"} | ${""}        | ${"John Doof <john@doof.com>"}
    ${"John Doof <john@doof.com>"} | ${" ?<.*>$"} | ${"John Doof"}
  `(
    "modify author by regex: $regexString",
    async ({ inputAuthor, regexString, expectedAuthor }) => {
      const subject = "some subject";
      await browser.storage.local.set({ joplinAuthorTrimRegex: regexString });

      const result = await processMail({
        id: 1,
        subject: subject,
        author: inputAuthor,
      });

      expect(result).toBe(null);
      expect(requests.length).toBe(1);
      expect(requests[0].body).toEqual(
        expect.objectContaining({ title: `${subject} from ${expectedAuthor}` })
      );

      expectConsole({
        log: 1,
        warn: 0,
        error: 0,
      });
    }
  );

  test.each`
    inputDate                          | dateFormat   | expectedDate
    ${new Date(2022, 4, 6)}            | ${""}        | ${new Date(2022, 4, 6).toString()}
    ${new Date("1995-12-17T03:24:00")} | ${"d.L.y T"} | ${"17.12.1995 03:24"}
  `(
    "apply date format: $dateFormat",
    async ({ inputDate, dateFormat, expectedDate }) => {
      const author = "author name";
      const subject = "some subject";
      await browser.storage.local.set({
        joplinNoteTitleTemplate: "{{subject}} from {{author}} at {{date}}",
        joplinDateFormat: dateFormat,
      });

      const result = await processMail({
        id: 1,
        subject: subject,
        author: author,
        date: inputDate,
      });

      expect(result).toBe(null);
      expect(requests.length).toBe(1);
      expect(requests[0].body).toEqual(
        expect.objectContaining({
          title: `${subject} from ${author} at ${expectedDate}`,
        })
      );

      expectConsole({
        log: 1,
        warn: 0,
        error: 0,
      });
    }
  );
});

describe("process tag", () => {
  test.each`
    emailTags      | includeEmailTags | customTags
    ${[]}          | ${false}         | ${""}
    ${[]}          | ${false}         | ${"customTag"}
    ${[]}          | ${true}          | ${""}
    ${[]}          | ${true}          | ${"customTag"}
    ${["$label1"]} | ${false}         | ${""}
    ${["$label1"]} | ${false}         | ${"customTag"}
    ${["$label1"]} | ${true}          | ${""}
    ${["$label1"]} | ${true}          | ${"customTag"}
    ${[]}          | ${false}         | ${" customTag "}
  `(
    "emailTags: $emailTags | includeEmailTags: $includeEmailTags | customTags: $customTags",
    async ({ emailTags, includeEmailTags, customTags }) => {
      await browser.storage.local.set({
        joplinNoteTags: customTags,
        joplinNoteTagsFromEmail: includeEmailTags,
      });

      const result = await processMail({ id: 0, tags: emailTags });
      expect(result).toBe(null);

      // 1 request to create the note.
      // 3 requests per tag: get tags, create tag, attach tag to note
      expect(requests.length).toBe(
        1 +
          3 * Number(customTags != "") +
          3 * Number(includeEmailTags && emailTags.length > 0)
      );

      expectConsole({
        log: 1,
        warn: 0,
        error: 0,
      });
    }
  );

  test("tag already existent", async () => {
    await browser.storage.local.set({ joplinNoteTags: "existentTag" });

    const result = await processMail({ id: 0, tags: [] });
    expect(result).toBe(null);

    // 1 request to create the note.
    // 1 request for searching the tag.
    // 1 request for attaching the tag to the note.
    expect(requests.length).toBe(3);

    expectConsole({
      log: 1,
      warn: 0,
      error: 0,
    });
  });

  test("too many tags existent", async () => {
    await browser.storage.local.set({ joplinNoteTags: "multipleTags" });

    const result = await processMail({ id: 0, tags: [] });
    expect(result).toBe(null);

    // 1 request to create the note.
    // 1 request for searching the tag.
    expect(requests.length).toBe(2);

    expectConsole({
      log: 1,
      warn: ['Too many matching tags for "multipleTags": a, b'],
      error: 0,
    });
  });
});

describe("process attachment", () => {
  beforeAll(() => {
    // FormData is not available: https://stackoverflow.com/a/59726560/7410886
    // It works, but not sure how to resolve the typescript issues.
    function FormDataMock() {
      // @ts-ignore
      this.append = jest.fn();
    }
    // @ts-ignore
    global.FormData = FormDataMock;
  });

  test.each`
    attachments | handleAttachments
    ${[]}       | ${"attach"}
    ${[]}       | ${"ignore"}
    ${["foo"]}  | ${"attach"}
    ${["foo"]}  | ${"ignore"}
  `(
    "attachments: $attachments | handleAttachments: $handleAttachments",
    async ({ attachments, handleAttachments }) => {
      await browser.storage.local.set({ joplinAttachments: handleAttachments });

      // Don't use once, since the functions gets only called in specific circumstances.
      browser.messages.listAttachments.mockResolvedValue(
        attachments.map((a: string) => {
          return { name: a, partName: a };
        })
      );
      browser.messages.getAttachmentFile.mockResolvedValue(attachments);

      const result = await processMail({ id: 0 });
      expect(result).toBe(null);

      // 1 request to create the note.
      // 1 request for creating the attachment (= resource in joplin).
      // 1 request for attaching the resource to the note.
      expect(requests.length).toBe(
        1 + 2 * Number(handleAttachments === "attach" && attachments.length > 0)
      );

      expectConsole({
        log: 1,
        warn: 0,
        error: 0,
      });
    }
  );
});

describe("util", () => {
  test.each`
    input        | expectedOutput
    ${""}        | ${true}
    ${"   "}     | ${true}
    ${" \n \t "} | ${true}
    ${"foo"}     | ${false}
    ${"  bar  "} | ${false}
  `(
    "onlyWhitespace | input: $input | expectedOutput: $expectedOutput",
    ({ input, expectedOutput }) => {
      expect(onlyWhitespace(input)).toBe(expectedOutput);
    }
  );

  test.each`
    template                        | context                  | expectedOutput
    ${""}                           | ${{}}                    | ${""}
    ${""}                           | ${{ defined: "123" }}    | ${""}
    ${"{{}}"}                       | ${{}}                    | ${"{{}}"}
    ${"{{ }}"}                      | ${{}}                    | ${"{{ }}"}
    ${"{{undefined}}"}              | ${{ defined: "123" }}    | ${"{{undefined}}"}
    ${"{{defined}}"}                | ${{ defined: "123" }}    | ${"123"}
    ${"{{ defined }}"}              | ${{ defined: "123" }}    | ${"123"}
    ${"{{{{defined}}}}"}            | ${{ defined: "123" }}    | ${"{{{{defined}}}}"}
    ${"{{defined}}: {{undefined}}"} | ${{ defined: "123" }}    | ${"123: {{undefined}}"}
    ${"{{defined}}: {{defined}}"}   | ${{ defined: "123" }}    | ${"123: 123"}
    ${"{{defined}}\n{{defined}}"}   | ${{ defined: "123" }}    | ${"123\n123"}
    ${"{{array}}"}                  | ${{ array: ["1", "2"] }} | ${"1,2"}
    ${"{{bool}}"}                   | ${{ bool: true }}        | ${"true"}
  `(
    "renderString | template: $template | context: $context | expectedOutput: $expectedOutput",
    ({ template, context, expectedOutput }) => {
      expect(renderString(template, context)).toBe(expectedOutput);
    }
  );
});
