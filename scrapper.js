const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { chromium, Page } = require('playwright');
require('dotenv').config({ quiet: true });

const BOOKS_BASE_URL = process.env.BOOKS_BASE_URL;
const BOOKS_ID = process.env.BOOKS_ID;
const GAMES_URL = process.env.GAMES_URL;
const GAME_SEARCH_BASE_URL = "https://thegamesdb.net/search.php?name=";
const AWS_REGION = process.env.AWS_REGION;
const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
const AWS_S3_BUCKET_DIR = process.env.AWS_S3_BUCKET_DIR;

const PAGE_OPTIONS = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1440, height: 850 },
};

const parseBookData = async (linkEl, imgEl) => {
    const linkHref = await linkEl.getAttribute('href');
    const imgMeta = await imgEl.getAttribute('alt');
    const imgUrl = await imgEl.getAttribute('src');
    const [title, author] = imgMeta.split(' by ');
    const bookUrl = `${BOOKS_BASE_URL}${linkHref}`;

    return { title, author, bookUrl, imgUrl };
}

const parseBooksProfileSectionData = async (page) => {
    const parseSectionBooks = async (section) => {
        const bookLinkEls = await section.$$('a.book-page-link');
        const data = [];

        for (const linkEl of bookLinkEls) {
            const imgEl = await linkEl.$('img');
            const bookData = await parseBookData(linkEl, imgEl);

            data.push(bookData);
        }

        return data;
    };

    const sections = await page.$$('div.container .standard-pane > div');
    const summaryPane = await page.$(`div.container .standard-pane:has(button:text("Stats"))`);
    if (!sections || !sections.length) {
        console.log('Err: Unable to parse sections');
        return;
    }
    if (!summaryPane) {
        console.log('Err: Unable to parse summary');

    }
    let readStyleSummary = '';
    const readStyleSummaryEls = await summaryPane.$$(':scope > span');

    readStyleSummaryEls.forEach(async (el, index) => {
        const text = await el.innerText();
        readStyleSummary = `${readStyleSummary}${index === 0 ? '' : ' '}${text}`;
    });

    const currentlyReading = await parseSectionBooks(sections[0]);
    const recentlyRead = await parseSectionBooks(sections[1]);
    const toReadPilePaneTitle = await sections[2].$(':scope > h2')
    const toReadCountText = await toReadPilePaneTitle.innerText();
    const toReadCount = parseInt(toReadCountText.replace(/\D+/g, ""), 10) || 0;

    return { currentlyReading, recentlyRead, readStyleSummary, toReadCount };
}

const parseBooksPageData = (isFavPage) => async (page) => {
    const panes = isFavPage ? await page.$$('.book-pane') : await page.$$('#up-next-book-panes .book-pane');
    const booksData = [];
    for (const pane of panes) {
        let tags = [];
        if (isFavPage) {
            const tagSectionEl = await pane.$('.book-pane-tag-section');
            const tagEls = await tagSectionEl.$$(':scope > div:first-of-type > span.text-teal-700');
            if (!tagEls) {
                console.log('Err: Unable to parse book pane tags section')
            }
            for (const t of tagEls) {
                const text = await t.innerText();
                if (text && text.length) {
                    tags.push(text);
                }
            }
        }

        const imgEl = await pane.$('.book-cover img');
        const linkEl = await pane.$('.book-cover a');
        const bookData = await parseBookData(linkEl, imgEl);

        booksData.push({ ...bookData, tags });
    }
    return booksData;
}


const parseGamesPageData = async (page) => {
    const gameEls = await page.$$('#app-Profile .user-container .list-unordered-base li>div');
    const lastPlayedGames = gameEls.slice(0, 3);
    const gamesData = [];

    for (const gameEl of lastPlayedGames) {
        const titleEl = await gameEl.$('.game-info .box h3 a[href^="https://www.exophase.com/game/"]');
        const imgEl = await gameEl.$('.col-image .image img');
        const lastPlayedEl = await gameEl.$('.lastplayed');
        const totalPlayedEl = await gameEl.$('.game-info .box .hours');
        const platformEl = await gameEl.$('.game-info .box .platforms .inline-pf');

        const title = await titleEl.innerText();
        const imgUrl = (await imgEl.getAttribute('src')).replace(/(games\/)./, "$1l");
        const lastPlayed = await lastPlayedEl.innerText();
        const totalPlaytime = await totalPlayedEl.innerText();
        const platform = await platformEl.innerText();

        gamesData.push({
            title,
            imgUrl,
            lastPlayed,
            totalPlaytime,
            platform,
            url: `${GAME_SEARCH_BASE_URL}${encodeURIComponent(title)}`,
        });
    }

    return gamesData;
};

const createBooksPageUrl = (path) => `${BOOKS_BASE_URL}/${path}/${BOOKS_ID}`;

const PAGES_CONFIG = [
    {
        url: createBooksPageUrl('profile'),
        parser: parseBooksProfileSectionData,
        dKey: 'main',
    },
    {
        url: createBooksPageUrl('to-read'),
        parser: parseBooksPageData(false),
        dKey: 'toRead'
    },
    {
        url: createBooksPageUrl('favorites'),
        parser: parseBooksPageData(true),
        dKey: 'favorites'
    },
    {
        url: GAMES_URL,
        parser: parseGamesPageData,
        dKey: 'games'
    }
];

(async () => {
    const s3 = new S3Client({ region: AWS_REGION });
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-first-run',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions'
        ],
    });
    const context = await browser.newContext(PAGE_OPTIONS);

    const finalPayload = {};

    for (const config of PAGES_CONFIG) {
        const { url, parser, dKey } = config;

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        const sectionData = await parser(page);
        finalPayload[dKey] = sectionData;

        await page.close();
    }

    await browser.close();

    try {
        const res = await s3.send(new PutObjectCommand({
            Bucket: AWS_S3_BUCKET_NAME,
            Key: `${AWS_S3_BUCKET_DIR}/data.json`,
            Body: JSON.stringify(finalPayload),
            ContentType: "application/json",
        }));

        const now = new Date();
        console.log('Data refreshed successfully:');
        console.log('  Timestamp:', now.toISOString());
        console.log('  ETag:', res.ETag);

    } catch (err) {
        console.error('Error uploading data:', err);
    }
})();