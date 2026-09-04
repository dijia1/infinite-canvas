package repository

import (
	"testing"

	"github.com/basketikun/infinite-canvas/model"
)

func TestListPortalMembersOnlyReturnsEnabledMembers(t *testing.T) {
	useImageTaskTestDB(t)
	if err := UpsertPortalMembers([]model.PortalMember{
		{UserUID: "enabled", DisplayName: "启用成员", Enabled: true, Roles: []string{"设计部"}},
		{UserUID: "disabled", DisplayName: "停用成员", Enabled: false, Roles: []string{"业务部"}},
	}); err != nil {
		t.Fatal(err)
	}

	items, total, err := ListPortalMembers(model.PortalMemberQuery{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(items) != 1 || items[0].UserUID != "enabled" {
		t.Fatalf("ListPortalMembers() = %#v, total=%d", items, total)
	}

	disabled, found, err := GetPortalMember("disabled")
	if err != nil || !found || disabled.Enabled {
		t.Fatalf("disabled member must remain retained: %#v, found=%t, err=%v", disabled, found, err)
	}
}
