// SPDX-License-Identifier: LicenseRef-AgentGoods-1.0
pragma solidity 0.8.28;

/**
 * @title EligibleHolderHeap
 * @notice Indexed binary max-heap over eligible-EOA AIC balances.
 * @dev This structure is the trustless answer to MASTER_PLAN §0.25.B: it lets the
 *      protocol verify "X is the current largest eligible EOA holder" with bounded
 *      O(log n) work per balance change and O(1) work at takeover finalization,
 *      with no backend assertion, no caller-supplied holder list and no unbounded loop.
 *
 *      Key properties relied upon elsewhere:
 *        - `items[0]` is always an address whose recorded key is >= every other
 *          recorded key in the heap (standard max-heap invariant).
 *        - Comparisons are STRICT. Equal keys never displace an incumbent, which
 *          implements the MASTER_PLAN §0.25.B tie rule ("a tie never grants takeover").
 *        - Only addresses the caller deems eligible are ever inserted; the caller is
 *          responsible for purging addresses that later stop being eligible.
 */
library EligibleHolderHeap {
    struct Heap {
        /// @dev Dense array of member addresses in heap order.
        address[] items;
        /// @dev member => (index + 1). Zero means "not a member".
        mapping(address => uint256) indexPlusOne;
        /// @dev member => ranking key (the member's eligible balance at last update).
        mapping(address => uint256) key;
    }

    /// @notice Number of members currently ranked.
    function size(Heap storage h) internal view returns (uint256) {
        return h.items.length;
    }

    /// @notice Address at the top of the heap, or address(0) when empty.
    function root(Heap storage h) internal view returns (address) {
        if (h.items.length == 0) return address(0);
        return h.items[0];
    }

    /// @notice Ranking key recorded for the top member (0 when empty).
    function rootKey(Heap storage h) internal view returns (uint256) {
        if (h.items.length == 0) return 0;
        return h.key[h.items[0]];
    }

    function contains(Heap storage h, address account) internal view returns (bool) {
        return h.indexPlusOne[account] != 0;
    }

    function keyOf(Heap storage h, address account) internal view returns (uint256) {
        return h.key[account];
    }

    /**
     * @notice Insert, update or remove `account` so its ranking key equals `newKey`.
     * @dev A `newKey` of zero removes the member. Worst case O(log n).
     */
    function set(Heap storage h, address account, uint256 newKey) internal {
        uint256 ip = h.indexPlusOne[account];

        if (newKey == 0) {
            if (ip != 0) _removeAt(h, ip - 1);
            return;
        }

        if (ip == 0) {
            h.items.push(account);
            uint256 idx = h.items.length - 1;
            h.indexPlusOne[account] = idx + 1;
            h.key[account] = newKey;
            _siftUp(h, idx);
            return;
        }

        uint256 index = ip - 1;
        uint256 oldKey = h.key[account];
        if (newKey == oldKey) return;
        h.key[account] = newKey;
        if (newKey > oldKey) {
            _siftUp(h, index);
        } else {
            _siftDown(h, index);
        }
    }

    /// @notice Remove `account` from the ranking entirely (used for eligibility purges).
    function remove(Heap storage h, address account) internal {
        uint256 ip = h.indexPlusOne[account];
        if (ip == 0) return;
        _removeAt(h, ip - 1);
    }

    // ------------------------------------------------------------- internal

    function _removeAt(Heap storage h, uint256 index) private {
        uint256 lastIndex = h.items.length - 1;
        address removed = h.items[index];

        if (index != lastIndex) {
            address moved = h.items[lastIndex];
            h.items[index] = moved;
            h.indexPlusOne[moved] = index + 1;
        }

        h.items.pop();
        delete h.indexPlusOne[removed];
        delete h.key[removed];

        if (index < lastIndex) {
            // The moved element may belong higher or lower than its new slot.
            _siftUp(h, index);
            _siftDown(h, index);
        }
    }

    function _siftUp(Heap storage h, uint256 index) private {
        address node = h.items[index];
        uint256 nodeKey = h.key[node];

        while (index > 0) {
            uint256 parentIndex = (index - 1) / 2;
            address parent = h.items[parentIndex];
            // Strict comparison: equal keys never displace the incumbent parent.
            if (h.key[parent] >= nodeKey) break;
            h.items[index] = parent;
            h.indexPlusOne[parent] = index + 1;
            index = parentIndex;
        }

        h.items[index] = node;
        h.indexPlusOne[node] = index + 1;
    }

    function _siftDown(Heap storage h, uint256 index) private {
        uint256 length = h.items.length;
        address node = h.items[index];
        uint256 nodeKey = h.key[node];

        while (true) {
            uint256 left = index * 2 + 1;
            if (left >= length) break;

            uint256 best = left;
            uint256 bestKey = h.key[h.items[left]];

            uint256 right = left + 1;
            if (right < length) {
                uint256 rightKey = h.key[h.items[right]];
                if (rightKey > bestKey) {
                    best = right;
                    bestKey = rightKey;
                }
            }

            // Strict comparison: a child equal to the node does not rise past it.
            if (bestKey <= nodeKey) break;

            address child = h.items[best];
            h.items[index] = child;
            h.indexPlusOne[child] = index + 1;
            index = best;
        }

        h.items[index] = node;
        h.indexPlusOne[node] = index + 1;
    }
}
