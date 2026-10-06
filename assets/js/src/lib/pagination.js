/* Call-list pagination arithmetic (QA round 2 module split).
 *
 * These were closures inside the 1,140-line CallModal component. The modal keeps
 * the state and the footer markup; the two decisions worth testing - how the
 * page buttons are collapsed around the current page, and which page a click is
 * allowed to reach - live here, together with the record-range wording that has
 * to agree with them.
 */
/* The rows-per-page choices the footer offers, in order. */
const PAGE_SIZES = [10, 25, 50, 100];

/*
 * Page buttons for `totalPages`, windowed around `page`, with the two ellipsis
 * markers the footer renders. With ten pages:
 *
 *   1 2 3 4 5 6 7      page <= 4
 *   1 ... 7 8 9 10     page >= totalPages - 3
 *   1 ... 4 5 6 ... 10 anywhere in the middle
 */
const buildPages = (totalPages, page) => {

        if (totalPages <= 7) {

            return Array.from(
                {
                    length:
                        totalPages
                },

                (_, i) =>
                    i + 1
            );
        }


        const result = [
            1
        ];


        /*
         * -------------------------------------------------
         * Near beginning
         * -------------------------------------------------
         */

        if (page <= 4) {

            result.push(2);
            result.push(3);
            result.push(4);
            result.push(5);

            result.push(
                'ellipsis-right'
            );
        }


        /*
         * -------------------------------------------------
         * Near end
         * -------------------------------------------------
         */

        else if (
            page >=
            totalPages - 3
        ) {

            result.push(
                'ellipsis-left'
            );

            result.push(
                totalPages - 4
            );

            result.push(
                totalPages - 3
            );

            result.push(
                totalPages - 2
            );

            result.push(
                totalPages - 1
            );
        }


        /*
         * -------------------------------------------------
         * Middle
         * -------------------------------------------------
         */

        else {

            result.push(
                'ellipsis-left'
            );

            result.push(
                page - 1
            );

            result.push(
                page
            );

            result.push(
                page + 1
            );

            result.push(
                'ellipsis-right'
            );
        }


        /*
         * -------------------------------------------------
         * Always show last page
         * -------------------------------------------------
         */

        result.push(
            totalPages
        );


        return result;
    };

/* A requested page, pulled into the range that exists. */
const clampPage = (target, totalPages) =>
    Math.max(1, Math.min(totalPages, target));

/* "Showing 0 of 0", or "Showing 26-50 of 1,234" (the label uses an en dash). */
const recordRangeLabel = (totalRecords, startIndex, endIndex) =>
    totalRecords === 0

        ? 'Showing 0 of 0'

        : `Showing ${
            startIndex + 1
        }–${
            endIndex
        } of ${
            totalRecords.toLocaleString()
        }`;

export { PAGE_SIZES, buildPages, clampPage, recordRangeLabel };
